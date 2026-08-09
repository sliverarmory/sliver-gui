package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"strings"

	command "github.com/bishopfox/sliver/client/command"
	client "github.com/bishopfox/sliver/client/console"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

const schemaVersion = 1

type inventory struct {
	SchemaVersion int           `json:"schemaVersion"`
	Commands      []commandNode `json:"commands"`
}

type commandNode struct {
	Surface             string              `json:"surface"`
	Path                []string            `json:"path"`
	Use                 string              `json:"use"`
	Aliases             []string            `json:"aliases"`
	Short               string              `json:"short"`
	Hidden              bool                `json:"hidden"`
	Deprecated          string              `json:"deprecated,omitempty"`
	Annotations         map[string]string   `json:"annotations"`
	Restrictions        restrictions        `json:"restrictions"`
	RestrictionEvidence restrictionEvidence `json:"restrictionEvidence"`
	Options             []option            `json:"options"`
	Source              source              `json:"source"`
	Fingerprint         string              `json:"fingerprint"`
}

type restrictions struct {
	TargetModes            []string `json:"targetModes"`
	TargetOperatingSystems []string `json:"targetOperatingSystems"`
	Transports             []string `json:"transports"`
}

type restrictionEvidence struct {
	TargetModes            string `json:"targetModes"`
	TargetOperatingSystems string `json:"targetOperatingSystems"`
	Transports             string `json:"transports"`
}

type restrictionState struct {
	Restrictions restrictions
	Evidence     restrictionEvidence
}

type option struct {
	Name        string   `json:"name"`
	Shorthand   string   `json:"shorthand,omitempty"`
	Type        string   `json:"type"`
	Default     string   `json:"default"`
	Usage       string   `json:"usage"`
	Required    bool     `json:"required"`
	Persistent  bool     `json:"persistent"`
	Annotations []string `json:"annotations,omitempty"`
}

type source struct {
	File   string `json:"file"`
	Line   int    `json:"line"`
	Symbol string `json:"symbol"`
}

func main() {
	console := client.NewConsole(false)
	console.IsCLI = true

	serverRoot := command.ServerCommands(console, nil)()
	implantRoot := command.SliverCommands(console)()

	commands := make([]commandNode, 0, 256)
	commands = append(commands, walk("server", nil, serverRoot, defaultRestrictions("server"))...)
	commands = append(commands, walk("implant", nil, implantRoot, defaultRestrictions("implant"))...)
	sort.Slice(commands, func(i, j int) bool {
		left := commands[i].Surface + "." + strings.Join(commands[i].Path, ".")
		right := commands[j].Surface + "." + strings.Join(commands[j].Path, ".")
		return left < right
	})

	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(inventory{SchemaVersion: schemaVersion, Commands: commands}); err != nil {
		fmt.Fprintf(os.Stderr, "encode parity inventory: %v\n", err)
		os.Exit(1)
	}
}

func walk(surface string, parent []string, root *cobra.Command, inherited restrictionState) []commandNode {
	children := append([]*cobra.Command(nil), root.Commands()...)
	sort.Slice(children, func(i, j int) bool { return children[i].Name() < children[j].Name() })

	result := make([]commandNode, 0, len(children))
	for _, cmd := range children {
		name := cmd.Name()
		if name == "help" || name == "completion" || name == "_carapace" || strings.HasPrefix(name, "__") {
			continue
		}
		path := append(append([]string(nil), parent...), name)
		node := inspect(surface, path, cmd, inherited)
		result = append(result, node)
		result = append(result, walk(surface, path, cmd, restrictionState{node.Restrictions, node.RestrictionEvidence})...)
	}
	return result
}

func inspect(surface string, path []string, cmd *cobra.Command, inherited restrictionState) commandNode {
	annotations := copyMap(cmd.Annotations)
	restriction := parseRestrictions(annotations, inherited)
	options := collectOptions(cmd)
	src := commandSource(cmd, surface, path)
	aliases := append([]string{}, cmd.Aliases...)
	sort.Strings(aliases)

	fingerprintInput, _ := json.Marshal(struct {
		Surface      string            `json:"surface"`
		Path         []string          `json:"path"`
		Use          string            `json:"use"`
		Annotations  map[string]string `json:"annotations"`
		Options      []option          `json:"options"`
		SourceSymbol string            `json:"sourceSymbol"`
	}{surface, path, cmd.Use, annotations, options, src.Symbol})
	digest := sha256.Sum256(fingerprintInput)

	return commandNode{
		Surface:             surface,
		Path:                path,
		Use:                 cmd.Use,
		Aliases:             aliases,
		Short:               strings.TrimSpace(cmd.Short),
		Hidden:              cmd.Hidden,
		Deprecated:          cmd.Deprecated,
		Annotations:         annotations,
		Restrictions:        restriction.Restrictions,
		RestrictionEvidence: restriction.Evidence,
		Options:             options,
		Source:              src,
		Fingerprint:         hex.EncodeToString(digest[:]),
	}
}

func collectOptions(cmd *cobra.Command) []option {
	result := make([]option, 0)
	seen := map[string]bool{}
	collect := func(set *pflag.FlagSet, persistent bool) {
		set.VisitAll(func(flag *pflag.Flag) {
			if seen[flag.Name] || flag.Name == "help" {
				return
			}
			seen[flag.Name] = true
			annotations := make([]string, 0)
			for key, values := range flag.Annotations {
				for _, value := range values {
					annotations = append(annotations, key+"="+value)
				}
			}
			sort.Strings(annotations)
			_, required := flag.Annotations[cobra.BashCompOneRequiredFlag]
			result = append(result, option{
				Name: flag.Name, Shorthand: flag.Shorthand, Type: flag.Value.Type(),
				Default: flag.DefValue, Usage: strings.TrimSpace(flag.Usage), Required: required,
				Persistent: persistent, Annotations: annotations,
			})
		})
	}
	collect(cmd.PersistentFlags(), true)
	collect(cmd.LocalNonPersistentFlags(), false)
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result
}

func defaultRestrictions(surface string) restrictionState {
	if surface == "implant" {
		return restrictionState{
			Restrictions: restrictions{[]string{"session", "beacon"}, []string{"windows", "linux", "darwin"}, []string{"any"}},
			Evidence: restrictionEvidence{
				TargetModes:            "sliver-commands-visible-unless-console-hidden",
				TargetOperatingSystems: "sliver-commands-visible-unless-console-hidden",
				Transports:             "sliver-commands-visible-unless-console-hidden",
			},
		}
	}
	return restrictionState{
		Restrictions: restrictions{[]string{"not-applicable"}, []string{"not-applicable"}, []string{"any"}},
		Evidence: restrictionEvidence{
			TargetModes:            "server-command-tree-not-target-bound",
			TargetOperatingSystems: "server-command-tree-not-target-bound",
			Transports:             "server-command-tree-visible-unless-console-hidden",
		},
	}
}

func parseRestrictions(annotations map[string]string, inherited restrictionState) restrictionState {
	values := make([]string, 0, len(annotations))
	for _, value := range annotations {
		values = append(values, strings.Split(strings.ToLower(value), ",")...)
	}
	has := func(expected string) bool {
		for _, value := range values {
			if strings.TrimSpace(value) == expected {
				return true
			}
		}
		return false
	}

	modes := append([]string{}, inherited.Restrictions.TargetModes...)
	modeEvidence := inherited.Evidence.TargetModes
	if has("session") && !has("beacon") {
		modes = []string{"session"}
		modeEvidence = "upstream-console-hidden-annotation"
	} else if has("beacon") && !has("session") {
		modes = []string{"beacon"}
		modeEvidence = "upstream-console-hidden-annotation"
	} else if has("session") && has("beacon") {
		modes = []string{"session", "beacon"}
		modeEvidence = "upstream-console-hidden-annotation"
	}
	operatingSystems := append([]string{}, inherited.Restrictions.TargetOperatingSystems...)
	operatingSystemEvidence := inherited.Evidence.TargetOperatingSystems
	if has("windows") {
		operatingSystems = []string{"windows"}
		operatingSystemEvidence = "upstream-console-hidden-annotation"
	}
	transports := append([]string{}, inherited.Restrictions.Transports...)
	transportEvidence := inherited.Evidence.Transports
	if has("wireguard") {
		transports = []string{"wireguard"}
		transportEvidence = "upstream-console-hidden-annotation"
	}
	return restrictionState{
		Restrictions: restrictions{modes, operatingSystems, transports},
		Evidence: restrictionEvidence{
			TargetModes:            modeEvidence,
			TargetOperatingSystems: operatingSystemEvidence,
			Transports:             transportEvidence,
		},
	}
}

func commandSource(cmd *cobra.Command, surface string, path []string) source {
	handlers := []any{cmd.RunE, cmd.Run, cmd.PersistentPreRunE, cmd.PersistentPreRun, cmd.PreRunE, cmd.PreRun}
	for _, handler := range handlers {
		if handler == nil {
			continue
		}
		value := reflect.ValueOf(handler)
		if value.Kind() != reflect.Func || value.IsNil() {
			continue
		}
		fn := runtime.FuncForPC(value.Pointer())
		if fn == nil {
			continue
		}
		file, line := fn.FileLine(value.Pointer())
		return source{File: normalizeSource(file), Line: line, Symbol: normalizeSymbol(fn.Name())}
	}
	fallback := "client/command/" + path[0] + "/commands.go"
	return source{File: fallback, Line: 0, Symbol: surface + "." + strings.Join(path, ".")}
}

func normalizeSource(path string) string {
	path = filepath.ToSlash(path)
	if index := strings.Index(path, "/client/"); index >= 0 {
		return strings.TrimPrefix(path[index+1:], "/")
	}
	if index := strings.Index(path, "/vendor/"); index >= 0 {
		return strings.TrimPrefix(path[index+1:], "/")
	}
	return filepath.Base(path)
}

func normalizeSymbol(symbol string) string {
	if index := strings.Index(symbol, "github.com/bishopfox/sliver/"); index >= 0 {
		return strings.TrimPrefix(symbol[index:], "github.com/bishopfox/sliver/")
	}
	return symbol
}

func copyMap(input map[string]string) map[string]string {
	if len(input) == 0 {
		return map[string]string{}
	}
	keys := make([]string, 0, len(input))
	for key := range input {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make(map[string]string, len(input))
	for _, key := range keys {
		result[key] = input[key]
	}
	return result
}
