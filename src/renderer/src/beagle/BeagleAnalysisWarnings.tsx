import { Accordion, Button } from "@heroui/react";
import type { BeagleAnalysisDiagnostics } from "../../../shared/beagle-diagnostics";

export interface BeagleAnalysisWarningsProps {
  diagnostics: BeagleAnalysisDiagnostics | undefined;
  onInspectObject: (objectid: string) => void;
  disabled?: boolean;
}

export function BeagleAnalysisWarnings({ diagnostics, onInspectObject, disabled = false }: BeagleAnalysisWarningsProps) {
  if (!diagnostics) return <p className="text-sm text-muted" role="status">Analysis choices have not been checked. Run Analyze to check this project.</p>;
  const choices = diagnostics.localGroupAmbiguities;
  if (!choices.length && !diagnostics.errors.length) return null;
  return <section aria-label="Analysis diagnostics" className="flex flex-col gap-3 text-sm">
    {diagnostics.errors.length > 0 && <div role="alert" className="flex flex-col gap-2">
      <p className="font-semibold text-warning">Analysis diagnostics are incomplete</p>
      <ul className="list-disc space-y-1 pl-5 text-muted">{diagnostics.errors.map((error, index) => <li key={index}>{error}</li>)}</ul>
    </div>}
    {choices.length > 0 && <>
      <div className="flex flex-col gap-1">
        <p className="font-semibold text-warning">{choices.length} ambiguous local-group {choices.length === 1 ? "choice" : "choices"}</p>
        <p className="text-muted">Beagle selected one local group for each privilege below. BloodHound CE may select a different candidate, so derived privileges and downstream paths can differ. Candidate memberships are not combined.</p>
      </div>
      <Accordion allowsMultipleExpanded hideSeparator>
        {choices.map((choice, index) => <Accordion.Item key={`${choice.computer}-${choice.suffix}`} id={`analysis-choice-${index}`}>
          <Accordion.Heading><Accordion.Trigger>
            <span className="min-w-0 break-all text-left">{choice.relationshipKind} on {choice.computer}</span>
            <Accordion.Indicator />
          </Accordion.Trigger></Accordion.Heading>
          <Accordion.Panel><Accordion.Body>
            <div className="flex flex-col gap-3">
              <Button size="sm" variant="secondary" isDisabled={disabled} onPress={() => onInspectObject(choice.computer)}>Inspect affected computer</Button>
              <p className="text-muted">Local group suffix {choice.suffix}. Selected group: <span className="break-all font-medium text-foreground">{choice.selectedGroup}</span>.</p>
              {choice.candidateGroups.map((group) => <div key={group.objectid} className="flex flex-col gap-2 border-t border-separator pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 break-all font-medium">{group.objectid}</span>
                  {group.objectid === choice.selectedGroup && <span className="text-xs text-warning">Selected by Beagle</span>}
                  <Button size="sm" variant="tertiary" aria-label={`Inspect group ${group.objectid}`} isDisabled={disabled} onPress={() => onInspectObject(group.objectid)}>Inspect group</Button>
                </div>
                <p className="text-muted">{group.directMembers.length} direct {group.directMembers.length === 1 ? "member" : "members"}</p>
                {group.directMembers.length > 0 && <ul className="max-h-48 space-y-1 overflow-y-auto pl-4 text-muted">{group.directMembers.map((member) => <li className="break-all" key={member}>{member}</li>)}</ul>}
              </div>)}
            </div>
          </Accordion.Body></Accordion.Panel>
        </Accordion.Item>)}
      </Accordion>
    </>}
  </section>;
}
