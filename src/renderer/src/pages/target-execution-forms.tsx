import {
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from "react";
import {
  Description,
  Disclosure,
  Input,
  Label,
  ListBox,
  Select,
  Switch,
  TextArea,
  TextField,
} from "@heroui/react";
import { CellSwitch } from "@heroui-pro/react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronDown,
  faFileArrowUp,
  faSliders,
} from "@fortawesome/free-solid-svg-icons";

import {
  EXECUTION_LIMITS,
  parseExecutionActionDraft,
  type ExecutionActionDraft,
  type ExecutionCapability,
  type ExecutionOperationId,
} from "../../../shared/execution-contracts";
import type { TargetSummary } from "../../../shared/target-contracts";
import {
  defaultExecutionTimeout,
  defaultHostProcess,
  defaultProcessExecutable,
  defaultShellcodeArchitecture,
} from "./target-execution-model";
import { parseProcessArgv } from "./process-argv";

export interface ExecutionActionFormProps {
  capability: ExecutionCapability;
  compactProcess?: boolean;
  error?: string;
  formId: string;
  isPreparing: boolean;
  operationId: Exclude<ExecutionOperationId, "execution.children" | "privilege.get">;
  target: TargetSummary;
  onPrepare: (draft: ExecutionActionDraft) => Promise<void>;
}

export function ExecutionActionForm({
  capability,
  compactProcess = false,
  error,
  formId,
  isPreparing,
  operationId,
  target,
  onPrepare,
}: ExecutionActionFormProps): React.JSX.Element {
  const passwordRef = useRef<HTMLInputElement>(null);
  const [validationError, setValidationError] = useState<string>();
  const [credentialConsumed, setCredentialConsumed] = useState(false);
  const [processOptions, setProcessOptions] = useState<ProcessOptions>(DEFAULT_PROCESS_OPTIONS);
  const useCompactProcess = compactProcess && operationId === "execution.process";

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const nativeSecretInput = event.currentTarget.querySelector<HTMLInputElement>("[data-execution-secret]");
    if (nativeSecretInput) passwordRef.current = nativeSecretInput;
    let draft: ExecutionActionDraft;
    try {
      draft = buildExecutionDraft(operationId, new FormData(event.currentTarget), passwordRef, useCompactProcess, target.os);
      setValidationError(undefined);
    } catch (draftError) {
      setValidationError(errorMessage(draftError));
      return;
    }

    const pending = onPrepare(draft);
    clearSecretInput(passwordRef);
    zeroCredentialDraft(draft);
    if (capability.credentialBearing) setCredentialConsumed(true);
    try {
      await pending;
    } catch (prepareError) {
      setCredentialConsumed(false);
      setValidationError(errorMessage(prepareError));
    }
  };

  return (
    <form className={`flex flex-col ${useCompactProcess ? "gap-3" : "gap-5"}`} id={formId} onSubmit={(event) => void submit(event)}>
        <fieldset className="contents" disabled={isPreparing}>
          {useCompactProcess ? (
            <>
              <div className="grid items-start gap-3 md:grid-cols-2">
                <TextInput defaultValue={defaultProcessExecutable(target.os)} label="Executable path" maxLength={EXECUTION_LIMITS.path} name="path" required />
                <TextInput label="Arguments" name="args" placeholder="--flag 'value with spaces'" />
              </div>
              <ProcessOptionsFields options={processOptions} platform={target.os} setOptions={setProcessOptions} />
            </>
          ) : (
            <>
              <ActionFields
                credentialConsumed={credentialConsumed}
                operationId={operationId}
                passwordRef={passwordRef}
                target={target}
              />
              <ArtifactReviewNotice capability={capability} />
              <AdvancedFields operationId={operationId} platform={target.os} />
            </>
          )}
        </fieldset>
        {validationError || error ? (
          <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger-soft-foreground" role="alert">
            {validationError ?? error}
          </p>
        ) : null}
    </form>
  );
}

interface ProcessOptions {
  background: boolean;
  captureOutput: boolean;
  inheritEnvironment: boolean;
  environment: string;
  useToken: boolean;
  hideWindow: boolean;
  timeoutSeconds: string;
  parentPid: string;
  stdoutPath: string;
  stderrPath: string;
}

const DEFAULT_PROCESS_OPTIONS: ProcessOptions = {
  background: false,
  captureOutput: true,
  inheritEnvironment: false,
  environment: "",
  useToken: false,
  hideWindow: false,
  timeoutSeconds: String(defaultExecutionTimeout("execution.process")),
  parentPid: "",
  stdoutPath: "",
  stderrPath: "",
};

function ProcessOptionsFields({
  options,
  platform,
  setOptions,
}: {
  options: ProcessOptions;
  platform: string;
  setOptions: React.Dispatch<React.SetStateAction<ProcessOptions>>;
}): React.JSX.Element {
  const isWindows = platform.trim().toLocaleLowerCase() === "windows";
  return (
    <section aria-label="Execution options" className="mt-4 flex flex-col gap-6">
      <h4 className="text-sm font-semibold text-foreground">Options</h4>
      <div className="grid gap-3 sm:grid-cols-2">
        <ProcessBooleanInput
          description="Run without waiting for process output."
          label="Run in background"
          name="background"
          selected={options.background}
          onChange={(background) => setOptions((current) => ({
            ...current,
            background,
            captureOutput: background ? false : current.captureOutput,
          }))}
        />
        <ProcessBooleanInput
          description="Return bounded stdout and stderr after execution."
          label="Capture output"
          name="captureOutput"
          selected={options.captureOutput}
          onChange={(captureOutput) => setOptions((current) => ({
            ...current,
            captureOutput,
            background: captureOutput ? false : current.background,
          }))}
        />
      </div>

      <section className="flex flex-col gap-3">
        <h5 className="text-sm font-semibold text-foreground">Environment</h5>
        <ProcessBooleanInput
          description="Start with the implant process environment before applying overrides."
          label="Inherit environment"
          name="inheritEnvironment"
          selected={options.inheritEnvironment}
          onChange={(inheritEnvironment) => setOptions((current) => ({ ...current, inheritEnvironment }))}
        />
        <LinesInput
          description="One NAME=value pair per line. Duplicate names are rejected."
          label="Environment overrides"
          name="environment"
          rows={3}
          value={options.environment}
          onChange={(environment) => setOptions((current) => ({ ...current, environment }))}
        />
      </section>

      {isWindows ? (
        <section className="flex flex-col gap-3">
          <h5 className="text-sm font-semibold text-foreground">Windows</h5>
          <div className="grid gap-3 sm:grid-cols-2">
            <ProcessBooleanInput
              description="Execute using the implant's current token."
              label="Use current token"
              name="useToken"
              selected={options.useToken}
              onChange={(useToken) => setOptions((current) => ({ ...current, useToken }))}
            />
            <ProcessBooleanInput
              description="Request a hidden process window."
              label="Hide window"
              name="hideWindow"
              selected={options.hideWindow}
              onChange={(hideWindow) => setOptions((current) => ({ ...current, hideWindow }))}
            />
          </div>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h5 className="text-sm font-semibold text-foreground">Advanced</h5>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Timeout seconds"
            max={EXECUTION_LIMITS.timeoutSeconds}
            min={1}
            name="timeoutSeconds"
            required
            type="number"
            value={options.timeoutSeconds}
            onChange={(timeoutSeconds) => setOptions((current) => ({ ...current, timeoutSeconds }))}
          />
          {isWindows ? (
            <TextInput
              label="Parent process ID"
              max={EXECUTION_LIMITS.pid}
              min={0}
              name="parentPid"
              type="number"
              value={options.parentPid}
              onChange={(parentPid) => setOptions((current) => ({ ...current, parentPid }))}
            />
          ) : null}
          <TextInput
            label="Remote stdout path"
            maxLength={EXECUTION_LIMITS.path}
            name="stdoutPath"
            placeholder="Optional"
            value={options.stdoutPath}
            onChange={(stdoutPath) => setOptions((current) => ({ ...current, stdoutPath }))}
          />
          <TextInput
            label="Remote stderr path"
            maxLength={EXECUTION_LIMITS.path}
            name="stderrPath"
            placeholder="Optional"
            value={options.stderrPath}
            onChange={(stderrPath) => setOptions((current) => ({ ...current, stderrPath }))}
          />
        </div>
      </section>
    </section>
  );
}

function ProcessBooleanInput({
  description,
  label,
  name,
  onChange,
  selected,
}: {
  description: string;
  label: string;
  name: string;
  onChange: (selected: boolean) => void;
  selected: boolean;
}): React.JSX.Element {
  return (
    <>
      <input name={name} type="hidden" value={String(selected)} />
      <CellSwitch
        aria-label={label}
        className="h-full w-full"
        isSelected={selected}
        variant="secondary"
        onChange={onChange}
      >
        <CellSwitch.Trigger className="h-full min-h-16 items-center px-4 py-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-start">
            <span className="text-sm font-medium text-foreground">{label}</span>
            <span className="text-xs leading-5 text-muted">{description}</span>
          </span>
          <CellSwitch.Control className="ml-auto" />
        </CellSwitch.Trigger>
      </CellSwitch>
    </>
  );
}

function ActionFields({
  credentialConsumed,
  operationId,
  passwordRef,
  target,
}: {
  credentialConsumed: boolean;
  operationId: ExecutionActionFormProps["operationId"];
  passwordRef: RefObject<HTMLInputElement | null>;
  target: TargetSummary;
}): React.JSX.Element {
  const platform = target.os.trim().toLocaleLowerCase();
  const hostProcess = defaultHostProcess(platform);
  const [background, setBackground] = useState(false);
  const [captureOutput, setCaptureOutput] = useState(true);
  const [assemblyIsDll, setAssemblyIsDll] = useState(false);
  const [assemblyInProcess, setAssemblyInProcess] = useState(false);
  const [migrateSelector, setMigrateSelector] = useState("pid");
  const [psexecSource, setPsexecSource] = useState("profile");
  const [sshAuthentication, setSshAuthentication] = useState("password");
  const [hijackSource, setHijackSource] = useState("profile");

  switch (operationId) {
    case "execution.process":
      return (
        <>
          <TextInput defaultValue={defaultProcessExecutable(platform)} label="Executable path" maxLength={EXECUTION_LIMITS.path} name="path" required />
          <LinesInput
            description="One argument per line. Values are sent as an explicit array, never as a shell command."
            label="Arguments"
            name="args"
            rows={4}
          />
          <div className="grid gap-3">
            <BooleanInput
              description="Track the child without capturing its output."
              label="Run in background"
              name="background"
              selected={background}
              stackContent
              onChange={(selected) => {
                setBackground(selected);
                if (selected) setCaptureOutput(false);
              }}
            />
            <BooleanInput
              description="Return bounded output through the operation result."
              label="Capture output"
              name="captureOutput"
              selected={captureOutput}
              stackContent
              onChange={(selected) => {
                setCaptureOutput(selected);
                if (selected) setBackground(false);
              }}
            />
          </div>
          <BooleanInput
            defaultSelected={false}
            description="Start with the implant process environment before applying overrides."
            label="Inherit environment"
            name="inheritEnvironment"
            stackContent
          />
          <LinesInput
            description="One NAME=value pair per line. Duplicate names are rejected."
            label="Environment overrides"
            name="environment"
            rows={4}
          />
          {platform === "windows" ? (
            <div className="grid gap-3">
              <BooleanInput
                defaultSelected={false}
                description="Execute using the implant's current Windows token."
                label="Use current token"
                name="useToken"
                stackContent
              />
              <BooleanInput
                defaultSelected={false}
                description="Request a hidden Windows process window."
                label="Hide window"
                name="hideWindow"
                stackContent
              />
            </div>
          ) : (
            <>
              <HiddenValue name="useToken" value="false" />
              <HiddenValue name="hideWindow" value="false" />
            </>
          )}
        </>
      );
    case "execution.assembly":
      return (
        <>
          <LinesInput label="Assembly arguments" name="args" rows={4} />
          <div className="grid gap-3 sm:grid-cols-2">
            <ChoiceInput
              defaultValue="x84"
              label="Assembly architecture"
              name="architecture"
              options={[
                { value: "x86", label: "x86" },
                { value: "x64", label: "x64" },
                { value: "x84", label: "AnyCPU (x84)" },
              ]}
            />
            <TextInput defaultValue={hostProcess} label="Host process" maxLength={EXECUTION_LIMITS.path} name="process" required />
          </div>
          <BooleanInput
            description="DLL assemblies require both class and method names."
            label="Assembly is a DLL"
            name="isDll"
            selected={assemblyIsDll}
            onChange={setAssemblyIsDll}
          />
          {assemblyIsDll ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="Class name" maxLength={EXECUTION_LIMITS.string} name="className" required />
              <TextInput label="Method name" maxLength={EXECUTION_LIMITS.string} name="method" required />
            </div>
          ) : null}
          <BooleanInput
            description="Run inside the current implant process instead of a child host."
            label="Run in process"
            name="inProcess"
            selected={assemblyInProcess}
            onChange={setAssemblyInProcess}
          />
          {assemblyInProcess ? (
            <>
              <TextInput label=".NET runtime" maxLength={EXECUTION_LIMITS.string} name="runtime" placeholder="Optional runtime" />
              <div className="grid gap-3 sm:grid-cols-2">
                <BooleanInput defaultSelected={false} description="Request the supported AMSI bypass." label="AMSI bypass" name="amsiBypass" />
                <BooleanInput defaultSelected={false} description="Request the supported ETW bypass." label="ETW bypass" name="etwBypass" />
              </div>
            </>
          ) : (
            <>
              <HiddenValue name="amsiBypass" value="false" />
              <HiddenValue name="etwBypass" value="false" />
            </>
          )}
          <TextInput label="AppDomain" maxLength={EXECUTION_LIMITS.string} name="appDomain" placeholder="Generated when omitted" />
          <LinesInput label="Host process arguments" name="processArgs" rows={3} />
        </>
      );
    case "execution.shellcode":
      return (
        <>
          <ChoiceInput
            defaultValue={defaultShellcodeArchitecture(target.arch)}
            label="Declared shellcode architecture"
            name="declaredArchitecture"
            options={[
              { value: "386", label: "386" },
              { value: "amd64", label: "amd64" },
              { value: "arm64", label: "arm64" },
            ]}
          />
          <TextInput defaultValue="0" label="Target process ID" max={EXECUTION_LIMITS.pid} min={0} name="pid" required type="number" />
          <BooleanInput
            defaultSelected={false}
            description="Request writable and executable memory pages. This increases detection risk."
            label="Use RWX pages"
            name="rwxPages"
          />
        </>
      );
    case "execution.sideload":
      return (
        <>
          <TextInput defaultValue={hostProcess} label="Host process" maxLength={EXECUTION_LIMITS.path} name="process" required />
          <LinesInput label="Library arguments" name="args" rows={4} />
          <TextInput label="Entry point" maxLength={EXECUTION_LIMITS.shortString} name="entryPoint" placeholder="Optional on non-Windows targets" />
          <LinesInput label="Host process arguments" name="processArgs" rows={3} />
          <div className="grid gap-3 sm:grid-cols-2">
            <BooleanInput defaultSelected={false} description="Pass an unmanaged Windows command line as Unicode." label="Unicode arguments" name="unicode" />
            <BooleanInput defaultSelected={false} description="Keep the host process alive after execution." label="Keep host alive" name="keepAlive" />
          </div>
        </>
      );
    case "execution.spawn-dll":
      return (
        <>
          <TextInput defaultValue={hostProcess} label="Host process" maxLength={EXECUTION_LIMITS.path} name="process" required />
          <TextInput defaultValue="ReflectiveLoader" label="Exported loader" maxLength={EXECUTION_LIMITS.shortString} name="entryPoint" required />
          <LinesInput label="DLL arguments" name="args" rows={4} />
          <BooleanInput defaultSelected={false} description="Keep the host process alive after execution." label="Keep host alive" name="keepAlive" />
        </>
      );
    case "execution.migrate":
      return (
        <>
          <ChoiceInput
            defaultValue="pid"
            label="Process selector"
            name="migrateSelector"
            options={[
              { value: "pid", label: "Process ID" },
              { value: "name", label: "Process name" },
            ]}
            onValueChange={setMigrateSelector}
          />
          {migrateSelector === "pid" ? (
            <TextInput label="Process ID" max={EXECUTION_LIMITS.pid} min={2} name="pid" required type="number" />
          ) : (
            <TextInput label="Process name" maxLength={EXECUTION_LIMITS.path} name="processName" required />
          )}
          <TextInput label="Shellcode encoder" maxLength={EXECUTION_LIMITS.shortString} name="encoder" placeholder="Optional" />
        </>
      );
    case "execution.msf":
    case "execution.msf-inject":
      return (
        <>
          {operationId === "execution.msf-inject" ? (
            <TextInput label="Process ID" max={EXECUTION_LIMITS.pid} min={2} name="pid" required type="number" />
          ) : null}
          <TextInput defaultValue="meterpreter_reverse_https" label="Payload" maxLength={EXECUTION_LIMITS.shortString} name="payload" required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput label="Listen host" maxLength={EXECUTION_LIMITS.shortString} name="lhost" required />
            <TextInput defaultValue="4444" label="Listen port" max={EXECUTION_LIMITS.port} min={1} name="lport" required type="number" />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput label="Encoder" maxLength={EXECUTION_LIMITS.shortString} name="encoder" placeholder="Optional" />
            <TextInput defaultValue="1" label="Encoder iterations" max={EXECUTION_LIMITS.iterations} min={0} name="iterations" required type="number" />
          </div>
        </>
      );
    case "execution.psexec":
      return (
        <>
          <TextInput label="Remote hostname" maxLength={EXECUTION_LIMITS.shortString} name="hostname" required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput defaultValue="Sliver" label="Service name" maxLength={EXECUTION_LIMITS.shortString} name="serviceName" required />
            <TextInput defaultValue="Sliver implant" label="Service description" maxLength={EXECUTION_LIMITS.string} name="serviceDescription" />
          </div>
          <TextInput defaultValue="C:\\Windows\\Temp" label="Remote upload directory" maxLength={EXECUTION_LIMITS.path} name="remotePath" required />
          <ChoiceInput
            defaultValue="profile"
            label="Service executable source"
            name="sourceKind"
            options={[
              { value: "profile", label: "Implant profile" },
              { value: "native-file", label: "Choose local executable during Review" },
            ]}
            onValueChange={setPsexecSource}
          />
          {psexecSource === "profile" ? (
            <TextInput label="Profile name" maxLength={EXECUTION_LIMITS.shortString} name="profileName" required />
          ) : null}
        </>
      );
    case "execution.ssh":
      return (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput label="Remote hostname" maxLength={EXECUTION_LIMITS.shortString} name="hostname" required />
            <TextInput defaultValue="22" label="Port" max={EXECUTION_LIMITS.port} min={1} name="port" required type="number" />
          </div>
          <TextInput label="Username" maxLength={EXECUTION_LIMITS.shortString} name="username" required />
          <LinesInput
            description="The first line is the executable; every following line is a separate argument."
            label="Remote command"
            name="command"
            required
            rows={4}
          />
          <ChoiceInput
            defaultValue="password"
            label="Authentication"
            name="authenticationKind"
            options={[
              { value: "password", label: "Password" },
              { value: "private-key", label: "Private key chosen during Review" },
              { value: "kerberos", label: "Kerberos" },
            ]}
            onValueChange={setSshAuthentication}
          />
          {sshAuthentication === "password" ? (
            credentialConsumed
              ? <CredentialConsumedNotice />
              : <SecretInput inputRef={passwordRef} label="Password" />
          ) : null}
          {sshAuthentication === "kerberos" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <TextInput label="Kerberos realm" maxLength={EXECUTION_LIMITS.shortString} name="realm" required />
              <TextInput defaultValue="/etc/krb5.conf" label="Remote Kerberos config" maxLength={EXECUTION_LIMITS.path} name="configPath" required />
            </div>
          ) : null}
        </>
      );
    case "execution.backdoor":
      return (
        <>
          <TextInput label="Remote executable path" maxLength={EXECUTION_LIMITS.path} name="remotePath" required />
          <div className="grid gap-3 sm:grid-cols-2">
            <TextInput label="Implant profile" maxLength={EXECUTION_LIMITS.shortString} name="profileName" required />
            <TextInput label="Implant name" maxLength={EXECUTION_LIMITS.shortString} name="name" required />
          </div>
        </>
      );
    case "execution.dll-hijack":
      return (
        <>
          <TextInput label="Reference DLL path" maxLength={EXECUTION_LIMITS.path} name="referenceDllPath" required />
          <TextInput label="Target location" maxLength={EXECUTION_LIMITS.path} name="targetLocation" required />
          <ChoiceInput
            defaultValue="profile"
            label="Target DLL source"
            name="sourceKind"
            options={[
              { value: "profile", label: "Implant profile" },
              { value: "native-file", label: "Choose local DLL during Review" },
            ]}
            onValueChange={setHijackSource}
          />
          {hijackSource === "profile" ? (
            <TextInput label="Profile name" maxLength={EXECUTION_LIMITS.shortString} name="profileName" required />
          ) : null}
          <TextInput label="Implant name" maxLength={EXECUTION_LIMITS.shortString} name="name" required />
          <BooleanInput
            defaultSelected={false}
            description="Choose and include a local copy of the reference DLL during Review."
            label="Include reference DLL"
            name="includeReferenceDll"
          />
        </>
      );
    case "privilege.run-as":
      return (
        <>
          <IdentityCredentialFields credentialConsumed={credentialConsumed} passwordRef={passwordRef} />
          <TextInput label="Process" maxLength={EXECUTION_LIMITS.path} name="process" required />
          <TextInput label="Process arguments" maxLength={EXECUTION_LIMITS.string} name="args" />
          <div className="grid gap-3 sm:grid-cols-2">
            <BooleanInput defaultSelected={false} description="Display the new process window." label="Show window" name="showWindow" />
            <BooleanInput defaultSelected={false} description="Use credentials only for remote network access." label="Network only" name="netOnly" />
          </div>
        </>
      );
    case "privilege.make-token":
      return (
        <>
          <IdentityCredentialFields credentialConsumed={credentialConsumed} passwordRef={passwordRef} />
          <ChoiceInput
            defaultValue="new-credentials"
            label="Logon type"
            name="logonType"
            options={[
              { value: "new-credentials", label: "New credentials" },
              { value: "interactive", label: "Interactive" },
              { value: "network", label: "Network" },
              { value: "batch", label: "Batch" },
              { value: "service", label: "Service" },
              { value: "unlock", label: "Unlock" },
              { value: "network-cleartext", label: "Network cleartext" },
            ]}
          />
        </>
      );
    case "privilege.impersonate":
      return <TextInput label="Logged-in username" maxLength={EXECUTION_LIMITS.shortString} name="username" required />;
    case "privilege.revert":
      return (
        <p className="rounded-xl bg-surface-secondary px-4 py-3 text-sm leading-6 text-muted">
          Review will show the current identity and the implant process identity that will be restored.
        </p>
      );
    case "privilege.get-system":
      return (
        <TextInput defaultValue="spoolsv.exe" label="SYSTEM host process" maxLength={EXECUTION_LIMITS.path} name="hostingProcess" required />
      );
  }
}

function IdentityCredentialFields({
  credentialConsumed,
  passwordRef,
}: {
  credentialConsumed: boolean;
  passwordRef: RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextInput label="Username" maxLength={EXECUTION_LIMITS.shortString} name="username" required />
        <TextInput label="Domain" maxLength={EXECUTION_LIMITS.shortString} name="domain" placeholder="Optional" />
      </div>
      {credentialConsumed ? <CredentialConsumedNotice /> : <SecretInput inputRef={passwordRef} label="Password" />}
    </>
  );
}

function CredentialConsumedNotice(): React.JSX.Element {
  return (
    <p className="rounded-xl bg-surface-secondary px-4 py-3 text-sm leading-6 text-muted" role="status">
      Credentials were transferred for this preparation and cleared from the form.
    </p>
  );
}

function ArtifactReviewNotice({ capability }: { capability: ExecutionCapability }): React.JSX.Element | null {
  if (capability.artifacts.length === 0) return null;
  return (
    <section className="rounded-xl bg-surface-secondary px-4 py-3" aria-label="Native file selection">
      <div className="flex items-start gap-3">
        <FontAwesomeIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-accent" icon={faFileArrowUp} />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Native files are chosen during Review</p>
          <p className="mt-1 text-xs leading-5 text-muted">
            File contents and paths stay in the main process. This form receives only sanitized review metadata.
          </p>
          <ul className="mt-2 flex flex-col gap-1 text-xs text-muted">
            {capability.artifacts.map((artifact) => (
              <li key={artifact.role}>
                <span className="font-medium text-foreground">{artifact.label}</span>
                {artifact.required ? " · required" : " · optional"}
                {artifact.acceptedExtensions.length > 0 ? ` · ${artifact.acceptedExtensions.join(", ")}` : ""}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function AdvancedFields({
  operationId,
  platform,
}: {
  operationId: ExecutionActionFormProps["operationId"];
  platform: string;
}): React.JSX.Element {
  const normalizedPlatform = platform.trim().toLocaleLowerCase();
  const supportsParentPid = operationId === "execution.assembly" ||
    operationId === "execution.sideload" ||
    (operationId === "execution.process" && normalizedPlatform === "windows");
  return (
    <Disclosure className="rounded-xl bg-surface-secondary">
      <Disclosure.Heading>
        <Disclosure.Trigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-foreground">
          <span className="flex items-center gap-2">
            <FontAwesomeIcon aria-hidden className="size-3.5 text-muted" icon={faSliders} />
            Advanced
          </span>
          <Disclosure.Indicator>
            <FontAwesomeIcon aria-hidden className="size-3 text-muted" icon={faChevronDown} />
          </Disclosure.Indicator>
        </Disclosure.Trigger>
      </Disclosure.Heading>
      <Disclosure.Content>
        <Disclosure.Body className="grid gap-3 px-4 pb-4 sm:grid-cols-2">
          <TextInput
            defaultValue={String(defaultExecutionTimeout(operationId))}
            label="Timeout seconds"
            max={EXECUTION_LIMITS.timeoutSeconds}
            min={1}
            name="timeoutSeconds"
            required
            type="number"
          />
          {supportsParentPid ? (
            <TextInput label="Parent process ID" max={EXECUTION_LIMITS.pid} min={0} name="parentPid" type="number" />
          ) : null}
          {operationId === "execution.process" ? (
            <>
              <TextInput label="Remote stdout path" maxLength={EXECUTION_LIMITS.path} name="stdoutPath" placeholder="Optional" />
              <TextInput label="Remote stderr path" maxLength={EXECUTION_LIMITS.path} name="stderrPath" placeholder="Optional" />
            </>
          ) : null}
        </Disclosure.Body>
      </Disclosure.Content>
    </Disclosure>
  );
}

function TextInput({
  defaultValue = "",
  inputRef,
  label,
  max,
  maxLength,
  min,
  name,
  onChange,
  placeholder,
  required = false,
  type = "text",
  value,
}: {
  defaultValue?: string;
  inputRef?: RefObject<HTMLInputElement | null>;
  label: string;
  max?: number;
  maxLength?: number;
  min?: number;
  name: string;
  onChange?: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: "text" | "number" | "password";
  value?: string;
}): React.JSX.Element {
  return (
    <TextField
      fullWidth
      {...(value === undefined ? { defaultValue } : { value, ...(onChange ? { onChange } : {}) })}
      isRequired={required}
      name={name}
      type={type}
      variant="secondary"
    >
      <Label>{label}</Label>
      <Input
        ref={inputRef}
        autoComplete={type === "password" ? "new-password" : "off"}
        {...(max === undefined ? {} : { max })}
        {...(maxLength === undefined ? {} : { maxLength })}
        {...(min === undefined ? {} : { min })}
        {...(placeholder === undefined ? {} : { placeholder })}
      />
    </TextField>
  );
}

function SecretInput({ inputRef, label }: { inputRef: RefObject<HTMLInputElement | null>; label: string }): React.JSX.Element {
  return (
    <TextField fullWidth isRequired type="password" variant="secondary">
      <Label>{label}</Label>
      <Input
        autoComplete="new-password"
        data-execution-secret="true"
        maxLength={EXECUTION_LIMITS.secretBytes}
        onChange={(event) => {
          // HeroUI's Input wrapper is not guaranteed to forward its component
          // ref in every renderer runtime. Capture the native event target so
          // credential reads and erasure always address the real DOM input.
          inputRef.current = event.currentTarget;
        }}
      />
      <Description>Used only for this reviewed operation and cleared immediately after preparation.</Description>
    </TextField>
  );
}

function LinesInput({
  description,
  label,
  name,
  onChange,
  required = false,
  rows,
  value,
}: {
  description?: string;
  label: string;
  name: string;
  onChange?: (value: string) => void;
  required?: boolean;
  rows: number;
  value?: string;
}): React.JSX.Element {
  return (
    <TextField fullWidth isRequired={required} name={name} variant="secondary" {...(value === undefined ? {} : { value, ...(onChange ? { onChange } : {}) })}>
      <Label>{label}</Label>
      <TextArea className="font-mono text-xs" rows={rows} />
      {description ? <Description>{description}</Description> : null}
    </TextField>
  );
}

function BooleanInput({
  defaultSelected,
  description,
  label,
  name,
  onChange,
  selected,
  stackContent = false,
}: {
  defaultSelected?: boolean;
  description: string;
  label: string;
  name: string;
  onChange?: (selected: boolean) => void;
  selected?: boolean;
  stackContent?: boolean;
}): React.JSX.Element {
  const [internalSelected, setInternalSelected] = useState(defaultSelected ?? false);
  const current = selected ?? internalSelected;
  const update = (next: boolean) => {
    if (selected === undefined) setInternalSelected(next);
    onChange?.(next);
  };
  return (
    <>
      <input name={name} type="hidden" value={String(current)} />
      <Switch
        className="flex w-full items-center rounded-xl bg-surface-secondary px-3 py-2.5"
        isSelected={current}
        {...(stackContent ? { style: { flexDirection: "row" } } : {})}
        onChange={update}
      >
        <Switch.Content className={stackContent ? "flex min-w-0 flex-1 flex-col items-start" : "min-w-0 flex-1"}>
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="mt-0.5 block text-xs leading-5 text-muted">{description}</span>
        </Switch.Content>
        <Switch.Control className="ml-3 shrink-0"><Switch.Thumb /></Switch.Control>
      </Switch>
    </>
  );
}

function ChoiceInput({
  defaultValue,
  label,
  name,
  onValueChange,
  options,
}: {
  defaultValue: string;
  label: string;
  name: string;
  onValueChange?: (value: string) => void;
  options: readonly { value: string; label: string }[];
}): React.JSX.Element {
  const [value, setValue] = useState(defaultValue);
  const selected = options.find((option) => option.value === value);
  return (
    <>
      <input name={name} type="hidden" value={value} />
      <Select
        fullWidth
        value={value}
        variant="secondary"
        onChange={(next) => {
          if (next === null || Array.isArray(next)) return;
          const normalized = String(next);
          if (!options.some((option) => option.value === normalized)) return;
          setValue(normalized);
          onValueChange?.(normalized);
        }}
      >
        <Label>{label}</Label>
        <Select.Trigger>
          <Select.Value>{selected?.label}</Select.Value>
          <Select.Indicator><FontAwesomeIcon aria-hidden className="size-3" icon={faChevronDown} /></Select.Indicator>
        </Select.Trigger>
        <Select.Popover>
          <ListBox>
            {options.map((option) => (
              <ListBox.Item id={option.value} key={option.value} textValue={option.label}>
                <Label>{option.label}</Label>
                <ListBox.ItemIndicator />
              </ListBox.Item>
            ))}
          </ListBox>
        </Select.Popover>
      </Select>
    </>
  );
}

function HiddenValue({ name, value }: { name: string; value: string }): React.JSX.Element {
  return <input name={name} type="hidden" value={value} />;
}

function buildExecutionDraft(
  operationId: ExecutionActionFormProps["operationId"],
  form: FormData,
  passwordRef: RefObject<HTMLInputElement | null>,
  compactProcess: boolean,
  platform: string,
): ExecutionActionDraft {
  const timeoutSeconds = integerField(form, "timeoutSeconds", 1, EXECUTION_LIMITS.timeoutSeconds);
  let draft: ExecutionActionDraft;
  switch (operationId) {
    case "execution.process":
      draft = {
        operationId,
        path: executablePathField(form, platform),
        args: compactProcess ? parseProcessArgv(optionalField(form, "args")) : lineFields(form, "args"),
        captureOutput: booleanField(form, "captureOutput"),
        background: booleanField(form, "background"),
        inheritEnvironment: booleanField(form, "inheritEnvironment"),
        environment: environmentFields(form, "environment"),
        useToken: booleanField(form, "useToken"),
        hideWindow: booleanField(form, "hideWindow"),
        timeoutSeconds,
        ...optionalStringProperty(form, "stdoutPath"),
        ...optionalStringProperty(form, "stderrPath"),
        ...optionalIntegerProperty(form, "parentPid", 0, EXECUTION_LIMITS.pid),
      };
      break;
    case "execution.assembly":
      draft = {
        operationId,
        args: lineFields(form, "args"),
        process: requiredField(form, "process"),
        isDll: booleanField(form, "isDll"),
        architecture: choiceField(form, "architecture", ["x86", "x64", "x84"]),
        processArgs: lineFields(form, "processArgs"),
        inProcess: booleanField(form, "inProcess"),
        amsiBypass: booleanField(form, "amsiBypass"),
        etwBypass: booleanField(form, "etwBypass"),
        timeoutSeconds,
        ...optionalStringProperty(form, "className"),
        ...optionalStringProperty(form, "method"),
        ...optionalStringProperty(form, "appDomain"),
        ...optionalStringProperty(form, "runtime"),
        ...optionalIntegerProperty(form, "parentPid", 0, EXECUTION_LIMITS.pid),
      };
      break;
    case "execution.shellcode":
      draft = {
        operationId,
        declaredArchitecture: choiceField(form, "declaredArchitecture", ["386", "amd64", "arm64"]),
        pid: integerField(form, "pid", 0, EXECUTION_LIMITS.pid),
        rwxPages: booleanField(form, "rwxPages"),
        timeoutSeconds,
      };
      break;
    case "execution.sideload":
      draft = {
        operationId,
        process: requiredField(form, "process"),
        args: lineFields(form, "args"),
        entryPoint: optionalField(form, "entryPoint"),
        unicode: booleanField(form, "unicode"),
        keepAlive: booleanField(form, "keepAlive"),
        processArgs: lineFields(form, "processArgs"),
        timeoutSeconds,
        ...optionalIntegerProperty(form, "parentPid", 0, EXECUTION_LIMITS.pid),
      };
      break;
    case "execution.spawn-dll":
      draft = {
        operationId,
        process: requiredField(form, "process"),
        args: lineFields(form, "args"),
        entryPoint: requiredField(form, "entryPoint"),
        keepAlive: booleanField(form, "keepAlive"),
        timeoutSeconds,
      };
      break;
    case "execution.migrate": {
      const selector = choiceField(form, "migrateSelector", ["pid", "name"]);
      draft = {
        operationId,
        timeoutSeconds,
        ...(selector === "pid"
          ? { pid: integerField(form, "pid", 2, EXECUTION_LIMITS.pid) }
          : { processName: requiredField(form, "processName") }),
        ...optionalStringProperty(form, "encoder"),
      };
      break;
    }
    case "execution.msf":
      draft = {
        operationId,
        payload: requiredField(form, "payload"),
        lhost: requiredField(form, "lhost"),
        lport: integerField(form, "lport", 1, EXECUTION_LIMITS.port),
        iterations: integerField(form, "iterations", 0, EXECUTION_LIMITS.iterations),
        timeoutSeconds,
        ...optionalStringProperty(form, "encoder"),
      };
      break;
    case "execution.msf-inject":
      draft = {
        operationId,
        pid: integerField(form, "pid", 2, EXECUTION_LIMITS.pid),
        payload: requiredField(form, "payload"),
        lhost: requiredField(form, "lhost"),
        lport: integerField(form, "lport", 1, EXECUTION_LIMITS.port),
        iterations: integerField(form, "iterations", 0, EXECUTION_LIMITS.iterations),
        timeoutSeconds,
        ...optionalStringProperty(form, "encoder"),
      };
      break;
    case "execution.psexec": {
      const sourceKind = choiceField(form, "sourceKind", ["profile", "native-file"]);
      draft = {
        operationId,
        hostname: requiredField(form, "hostname"),
        serviceName: requiredField(form, "serviceName"),
        serviceDescription: optionalField(form, "serviceDescription"),
        remotePath: requiredField(form, "remotePath"),
        source: sourceKind === "profile"
          ? { kind: "profile", profileName: requiredField(form, "profileName") }
          : { kind: "native-file" },
        timeoutSeconds,
      };
      break;
    }
    case "execution.ssh": {
      const authenticationKind = choiceField(form, "authenticationKind", ["password", "private-key", "kerberos"]);
      draft = {
        operationId,
        hostname: requiredField(form, "hostname"),
        port: integerField(form, "port", 1, EXECUTION_LIMITS.port),
        username: requiredField(form, "username"),
        command: requiredLineFields(form, "command"),
        authentication: authenticationKind === "password"
          ? { kind: "password", password: secretValue(passwordRef) }
          : authenticationKind === "private-key"
            ? { kind: "private-key" }
            : {
                kind: "kerberos",
                realm: requiredField(form, "realm"),
                configPath: requiredField(form, "configPath"),
              },
        timeoutSeconds,
      };
      break;
    }
    case "execution.backdoor":
      draft = {
        operationId,
        remotePath: requiredField(form, "remotePath"),
        profileName: requiredField(form, "profileName"),
        name: requiredField(form, "name"),
        timeoutSeconds,
      };
      break;
    case "execution.dll-hijack": {
      const sourceKind = choiceField(form, "sourceKind", ["profile", "native-file"]);
      draft = {
        operationId,
        referenceDllPath: requiredField(form, "referenceDllPath"),
        targetLocation: requiredField(form, "targetLocation"),
        source: sourceKind === "profile"
          ? { kind: "profile", profileName: requiredField(form, "profileName") }
          : { kind: "native-file" },
        includeReferenceDll: booleanField(form, "includeReferenceDll"),
        name: requiredField(form, "name"),
        timeoutSeconds,
      };
      break;
    }
    case "privilege.run-as":
      draft = {
        operationId,
        username: requiredField(form, "username"),
        domain: optionalField(form, "domain"),
        password: secretValue(passwordRef),
        process: requiredField(form, "process"),
        args: optionalField(form, "args"),
        showWindow: booleanField(form, "showWindow"),
        netOnly: booleanField(form, "netOnly"),
        timeoutSeconds,
      };
      break;
    case "privilege.make-token":
      draft = {
        operationId,
        username: requiredField(form, "username"),
        domain: optionalField(form, "domain"),
        password: secretValue(passwordRef),
        logonType: choiceField(form, "logonType", [
          "interactive",
          "network",
          "batch",
          "service",
          "unlock",
          "network-cleartext",
          "new-credentials",
        ]),
        timeoutSeconds,
      };
      break;
    case "privilege.impersonate":
      draft = { operationId, username: requiredField(form, "username"), timeoutSeconds };
      break;
    case "privilege.revert":
      draft = { operationId, timeoutSeconds };
      break;
    case "privilege.get-system":
      draft = { operationId, hostingProcess: requiredField(form, "hostingProcess"), timeoutSeconds };
      break;
  }
  return parseExecutionActionDraft(draft);
}

function requiredField(form: FormData, name: string): string {
  const value = optionalField(form, name).trim();
  if (!value) throw new TypeError(`${fieldLabel(name)} is required`);
  return value;
}

function executablePathField(form: FormData, platform: string): string {
  const path = requiredField(form, "path");
  if (platform.trim().toLocaleLowerCase() !== "windows") return path;
  const startsQuoted = path.startsWith('"');
  const endsQuoted = path.endsWith('"');
  if (startsQuoted !== endsQuoted || (startsQuoted && path.length === 2)) {
    throw new TypeError("Executable path has unmatched double quotes");
  }
  const unquoted = startsQuoted ? path.slice(1, -1) : path;
  if (!unquoted.trim()) throw new TypeError("Executable path is required");
  return unquoted;
}

function optionalField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

function lineFields(form: FormData, name: string): string[] {
  return optionalField(form, name).split(/\r?\n/u).filter((line) => line.length > 0);
}

function requiredLineFields(form: FormData, name: string): string[] {
  const values = lineFields(form, name);
  if (values.length === 0) throw new TypeError(`${fieldLabel(name)} is required`);
  return values;
}

function environmentFields(form: FormData, name: string): { name: string; value: string }[] {
  return lineFields(form, name).map((line, index) => {
    const separator = line.indexOf("=");
    if (separator <= 0) throw new TypeError(`Environment line ${index + 1} must use NAME=value`);
    return { name: line.slice(0, separator).trim(), value: line.slice(separator + 1) };
  });
}

function integerField(form: FormData, name: string, minimum: number, maximum: number): number {
  const value = requiredField(form, name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new TypeError(`${fieldLabel(name)} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function booleanField(form: FormData, name: string): boolean {
  return optionalField(form, name) === "true";
}

function choiceField<const Value extends string>(form: FormData, name: string, choices: readonly Value[]): Value {
  const value = requiredField(form, name);
  if (!choices.includes(value as Value)) throw new TypeError(`${fieldLabel(name)} is invalid`);
  return value as Value;
}

function optionalStringProperty<Name extends string>(form: FormData, name: Name): { [Key in Name]?: string } {
  const value = optionalField(form, name).trim();
  return value ? { [name]: value } as { [Key in Name]?: string } : {};
}

function optionalIntegerProperty<Name extends string>(
  form: FormData,
  name: Name,
  minimum: number,
  maximum: number,
): { [Key in Name]?: number } {
  const value = optionalField(form, name).trim();
  return value
    ? { [name]: integerField(form, name, minimum, maximum) } as { [Key in Name]?: number }
    : {};
}

function secretValue(ref: RefObject<HTMLInputElement | null>): Uint8Array {
  const value = ref.current?.value ?? "";
  if (!value) throw new TypeError("Password is required");
  return new Uint8Array(new TextEncoder().encode(value));
}

function clearSecretInput(ref: RefObject<HTMLInputElement | null>): void {
  if (!ref.current) return;
  ref.current.value = "";
}

function zeroCredentialDraft(draft: ExecutionActionDraft): void {
  if (draft.operationId === "privilege.run-as" || draft.operationId === "privilege.make-token") {
    draft.password.fill(0);
  }
  if (draft.operationId === "execution.ssh" && draft.authentication.kind === "password") {
    draft.authentication.password.fill(0);
  }
}

function fieldLabel(name: string): string {
  return name.replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, (value) => value.toLocaleUpperCase());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
