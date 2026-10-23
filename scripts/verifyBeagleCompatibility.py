#!/usr/bin/env python3
"""Compare a private SharpHound collection against disposable BloodHound CE.

Requires Docker Compose and neo4j==5.28.2 in this Python interpreter. The pinned
Beagle checkout must include its separately retained, checksum-verified local
oracle tools. All graphs, logs and results stay in a new private output folder.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import socket
import subprocess
import sys
import uuid

SOURCE_COMMIT = "6dc34300f67d025dccd4c7fef36cf31210c46a42"
BLOODHOUND_COMMIT = "1759e1638435595def27eb3ff3c5a6fc32832ddc"
INPUT_HASHES = {
    "tools/oracle.py": "3a82e16ab46fbf9cba7b9bfbbf11251ad8fb18fa3a23161a8458685df1eca906",
    "tools/query_parity.py": "de39e213b5d0076796fe5cfdb4cdda4df045739964c06406a6b7f70241f30ba6",
    "tools/oracle_api_parity.py": "c84782e6d707f453a6016c8ea631b1f4d8d176a681af7b5bb0f9ec67cbf4f6ba",
    "data/queries.json": "878494e95e4f9474f67a3263f14bd953eca904e8b0ebf7c3040955393214b725",
    "data/ad-attack-paths.json": "a686c67cb0e26873c0231d6a6b2f498cae7258cedd80a61f4f48d0ed2a9362be",
}
PASS_STATUSES = {
    "exact_nonempty", "equal_empty_not_exercised", "equivalent_shortest_ties",
    "equivalent_limited_shortest",
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, default=str) + "\n")
    path.chmod(0o600)


def progress(event, **details):
    print(json.dumps({"event": event, **details}), flush=True)


def capture(command, output, timeout=300):
    """Keep subprocess data/errors in private files, never echo graph contents."""
    with output.open("w") as stdout, output.with_suffix(output.suffix + ".stderr").open("w") as stderr:
        subprocess.run([str(arg) for arg in command], stdout=stdout, stderr=stderr,
                       check=True, timeout=timeout, env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})


def canonical_graph(snapshot, plain):
    def properties(value):
        return plain({k: v for k, v in value.items()
                      if k not in ("firstseen", "lastseen", "lastcollected")})
    nodes = [{"objectid": n["objectid"], "labels": sorted(n["labels"]),
              "properties": properties(n["properties"])} for n in snapshot["nodes"]]
    edges = [{"source": e["source"], "target": e["target"], "kind": e["kind"],
              "properties": properties(e["properties"])} for e in snapshot["edges"]]
    require(all(n["objectid"] is not None for n in nodes), "Node missing AD identity")
    require(all(e["source"] is not None and e["target"] is not None for e in edges),
            "Relationship missing AD endpoint identity")
    require(len({n["objectid"] for n in nodes}) == len(nodes), "Duplicate node identities")
    require(len({(e["source"], e["target"], e["kind"]) for e in edges}) == len(edges),
            "Duplicate relationship identities")
    return {"nodes": sorted(map(encode, nodes)), "edges": sorted(map(encode, edges))}


def compare_graphs(output, stage, plain):
    actual = canonical_graph(json.loads((output / f"beagle-{stage}.json").read_text()), plain)
    expected = canonical_graph(json.loads((output / f"ce-{stage}.json").read_text()), plain)
    result = {"stage": stage, "passed": actual == expected,
              "beagle_nodes": len(actual["nodes"]), "beagle_edges": len(actual["edges"]),
              "ce_nodes": len(expected["nodes"]), "ce_edges": len(expected["edges"]),
              "beagle_sha256": hashlib.sha256(encode(actual).encode()).hexdigest(),
              "ce_sha256": hashlib.sha256(encode(expected).encode()).hexdigest(),
              "differences": {k: len(set(actual[k]) ^ set(expected[k])) for k in ("nodes", "edges")}}
    write_json(output / f"{stage}-comparison.json", result)
    progress("graph-comparison", **result)
    require(result["passed"], f"Independent {stage} graph comparison failed")
    return result


def unused_ports():
    sockets = []
    try:
        for _ in range(3):
            connection = socket.socket()
            connection.bind(("127.0.0.1", 0))
            sockets.append(connection)
        return [connection.getsockname()[1] for connection in sockets]
    finally:
        for connection in sockets:
            connection.close()


def check_inputs(args):
    source = args.beagle_source
    actual = subprocess.check_output(["git", "-C", str(source), "rev-parse", "HEAD"], text=True).strip()
    require(actual == SOURCE_COMMIT, f"Beagle source must be pinned to {SOURCE_COMMIT}")
    dirty = subprocess.check_output(["git", "-C", str(source), "status", "--porcelain", "--untracked-files=no"], text=True)
    require(not dirty, "Beagle tracked sources must be clean")
    for relative, expected in INPUT_HASHES.items():
        path = source / relative
        require(path.is_file(), f"Missing external Beagle validation input: {relative}; see docs/beagle-verification.md")
        require(digest(path) == expected, f"Pinned input checksum mismatch: {relative}")
    require(args.binary.is_file(), "Build or supply the Beagle executable with --binary")
    require(args.collection.is_file(), "--collection must name a SharpHound ZIP or JSON file")
    require(args.bindings.is_file(), "--bindings must name dataset-specific query template bindings")
    require(not args.output.exists(), "--output must be a new directory; existing evidence is never overwritten")
    require(not args.output.is_relative_to(source) and not args.output.is_relative_to(Path(__file__).resolve().parents[1]),
            "--output must stay outside both source trees because it contains private collection data")
    import neo4j
    require(neo4j.__version__ == "5.28.2", "Install neo4j==5.28.2 in this Python interpreter")
    subprocess.run(["docker", "compose", "version"], check=True, stdout=subprocess.DEVNULL)
    version = subprocess.check_output([str(args.binary), "--version"], text=True).strip()
    require(version == "beagle 0.1.0", "Expected Beagle 0.1.0")


def run(args):
    check_inputs(args)
    os.umask(0o077)
    args.output.mkdir(mode=0o700, parents=True)
    output = args.output
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(args.beagle_source / "tools"))
    from oracle import Oracle, initialize
    from query_parity import plain
    from oracle_api_parity import api_projection, neo_projection
    tools = args.beagle_source / "tools"
    state = output / "oracle-state"
    project = "sliver-gui-beagle-" + uuid.uuid4().hex
    summary = {
        "started_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "beagle_commit": SOURCE_COMMIT, "beagle_version": "0.1.0",
        "bloodhound_commit": BLOODHOUND_COMMIT, "bloodhound_version": "9.8.0",
        "neo4j_version": "4.4.42", "python_driver": "5.28.2",
        "binary_sha256": digest(args.binary), "collection_sha256": digest(args.collection),
        "bindings_sha256": digest(args.bindings), "input_sha256": INPUT_HASHES,
        "normalization": ["firstseen", "lastseen", "lastcollected", "Beagle derived bookkeeping"],
        "numeric_types_preserved": True, "passed": False,
    }
    initialized = False
    completed = False
    cleanup_ok = True
    try:
        progress("native-import")
        native_db = output / "goad.db"
        capture([args.binary, "--db", native_db, "ingest", args.collection, "--analyze"], output / "ingest.json")
        capture([args.binary, "--db", native_db, "export", "--raw"], output / "beagle-raw.json")
        capture([args.binary, "--db", native_db, "export"], output / "beagle-analyzed.json")
        ports = unused_ports()
        initialize(state, True, configuration={"project": project, "api_port": ports[0],
                                               "bolt_port": ports[1], "http_port": ports[2]})
        initialized = True
        progress("oracle-start", project=project)
        oracle_command = [sys.executable, tools / "oracle.py", "--state", state]
        capture([*oracle_command, "start", "--disable-analysis"], output / "oracle-start.log", 420)
        oracle = Oracle(state)
        job = oracle.upload([args.collection])
        raw_job = oracle.await_job(job)
        write_json(output / "ce-raw.json", oracle.snapshot())
        summary["raw_graph"] = compare_graphs(output, "raw", plain)
        progress("oracle-analysis")
        capture([*oracle_command, "start"], output / "oracle-analysis.log", 420)
        oracle = Oracle(state)
        summary["upload"] = oracle.await_job(job, analyzed=True)
        require(summary["upload"]["failed_files"] == 0 and summary["upload"]["partial_failed_files"] == 0,
                "CE did not successfully ingest every collection file")
        require(raw_job["total_files"] > 0, "CE import did not exercise any files")
        write_json(output / "ce-analyzed.json", oracle.snapshot())
        summary["analyzed_graph"] = compare_graphs(output, "analyzed", plain)
        examples = []
        with oracle.driver() as driver, driver.session() as session:
            for name, query in [
                ("users", "MATCH (u:User) RETURN count(u) AS users"),
                ("membership_paths", "MATCH p=(:User)-[:MemberOf*1..3]->(:Group) RETURN count(p) AS membership_paths"),
                ("acl_paths", "MATCH p=(a)-[r]->(b) WHERE r.isacl RETURN count(p) AS acl_paths"),
                ("tier_zero", "MATCH (n:Tag_Tier_Zero) RETURN count(n) AS tier_zero"),
            ]:
                records = list(session.run(query))
                capture([args.binary, "--db", native_db, "query", query], output / f"example-{name}.json")
                actual = json.loads((output / f"example-{name}.json").read_text())
                api = oracle.graph_query(query)
                passed = actual["rows"] == [dict(r) for r in records] and api_projection(api) == neo_projection(records)
                examples.append({"query": query, "beagle": actual, "passed": passed})
                require(passed, f"Native import scalar query differs: {name}")
        summary["native_query_examples"] = examples
        query_db = output / "oracle-queries.db"
        capture([args.binary, "--db", query_db, "import-snapshot", output / "ce-analyzed.json"], output / "query-import.json")
        progress("api-parity")
        capture([sys.executable, tools / "oracle_api_parity.py", "--state", state,
                 "--output", output / "api.json", "--cli-db", query_db, "--binary", args.binary], output / "api.log", 900)
        api = json.loads((output / "api.json").read_text())["results"]
        summary["api"] = {"total": len(api), "passed": sum(r["status"] == "pass" for r in api),
                          "nonempty": sum(bool(r.get("nonempty")) for r in api)}
        require(len(api) == 16 and summary["api"]["passed"] == 16, "API suite incomplete or failed")
        progress("catalog-parity", entries=177)
        capture([sys.executable, tools / "query_parity.py", "--state", state, "--db", query_db,
                 "--binary", args.binary, "--output", output / "queries.json", "--bindings", args.bindings,
                 "--timeout", "15", "--workers", "2"], output / "queries.log", 3600)
        queries = json.loads((output / "queries.json").read_text())
        summary["queries"] = dict(collections.Counter(r["status"] for r in queries["results"]))
        summary["graph_unchanged"] = queries.get("graph_unchanged", False)
        summary["execution_artifacts_unchanged"] = queries.get("execution_artifacts_unchanged", False)
        require(len(queries["results"]) == 177, "Full catalog did not complete")
        require(set(summary["queries"]) <= PASS_STATUSES, "Catalog has failed or unproven cases; verify dataset bindings")
        require(summary["graph_unchanged"] and summary["execution_artifacts_unchanged"], "Comparison changed during execution")
        summary["all_inputs_unchanged"] = (
            digest(args.binary) == summary["binary_sha256"]
            and digest(args.collection) == summary["collection_sha256"]
            and digest(args.bindings) == summary["bindings_sha256"]
            and all(digest(args.beagle_source / relative) == expected for relative, expected in INPUT_HASHES.items())
        )
        require(summary["all_inputs_unchanged"], "An input changed during the complete validation run")
        completed = True
        progress("comparison-complete", api=summary["api"], queries=summary["queries"])
    except (Exception, KeyboardInterrupt) as error:
        (output / "failure.txt").write_text(f"{type(error).__name__}: {error}\n")
        progress("failed", diagnostic=str(output / "failure.txt"))
    finally:
        if initialized:
            try:
                capture(["docker", "compose", "-p", project, "-f", state / "compose.json",
                         "down", "--volumes"], output / "cleanup.log", 180)
                remaining = {}
                for name, command in [
                    ("containers", ["docker", "ps", "-aq", "--filter", "label=com.docker.compose.project=" + project]),
                    ("volumes", ["docker", "volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project]),
                ]:
                    remaining[name] = len(subprocess.check_output(command, text=True).splitlines())
                require(not any(remaining.values()), "Owned oracle resources remain after cleanup")
                shutil.rmtree(state)
                summary["cleanup"] = {"project": project, "remaining": remaining, "credentials_removed": True}
            except Exception as error:
                cleanup_ok = False
                (output / "cleanup-failure.txt").write_text(f"{type(error).__name__}: {error}\n")
                summary["cleanup"] = {"project": project, "passed": False, "state_retained": str(state)}
                progress("cleanup-failed", diagnostic=str(output / "cleanup-failure.txt"))
        elif state.exists():
            shutil.rmtree(state)
        summary["passed"] = completed and cleanup_ok
        summary["finished_at"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
        write_json(output / "summary.json", summary)
    progress("finished", passed=summary["passed"], report=str(output / "summary.json"))
    return 0 if summary["passed"] else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--beagle-source", required=True, type=Path)
    parser.add_argument("--collection", required=True, type=Path, help="Private SharpHound ZIP or JSON file")
    parser.add_argument("--bindings", required=True, type=Path, help="Dataset-specific bindings for all four catalog templates")
    parser.add_argument("--output", required=True, type=Path, help="New private evidence directory")
    parser.add_argument("--binary", type=Path, help="Defaults to BEAGLE_SOURCE/target/release/beagle")
    args = parser.parse_args()
    args.beagle_source = args.beagle_source.resolve()
    args.collection = args.collection.resolve()
    args.bindings = args.bindings.resolve()
    args.output = args.output.resolve()
    args.binary = (args.binary or args.beagle_source / "target/release/beagle").resolve()
    def interrupted(_signum, _frame):
        raise KeyboardInterrupt("Termination requested")
    signal.signal(signal.SIGTERM, interrupted)
    try:
        return run(args)
    except Exception as error:
        print(f"Compatibility prerequisites failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
