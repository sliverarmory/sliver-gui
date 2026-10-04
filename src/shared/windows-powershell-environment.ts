/**
 * PowerShell 7 only repairs PSModulePath when it directly starts Windows
 * PowerShell. Node intermediaries retain incompatible PowerShell 7 modules.
 * Omit the inherited variable so stock powershell.exe rebuilds its defaults:
 * https://learn.microsoft.com/powershell/module/microsoft.powershell.core/about/about_psmodulepath#starting-windows-powershell-from-powershell-7
 */
export function windowsPowerShellEnvironment<T extends string | undefined>(
  environment: Readonly<Record<string, T>>,
): Record<string, T> {
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"),
  );
}
