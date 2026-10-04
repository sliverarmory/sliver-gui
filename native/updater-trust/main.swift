import AppKit
import CryptoKit
import Foundation
import Security
import SecurityInterface

// Only this signed bundle's pinned public certificate is eligible. No certificate
// or key downloaded from the update feed is accepted by this helper.
struct SigningManifest: Decodable {
  struct Identity: Decodable { let sha256: String }
  let schemaVersion: Int
  let macos: Identity
}

enum HelperError: Error { case invalidInput, invalidCertificate, securityFailure }

func fingerprint(_ data: Data) -> String {
  SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
}

func loadBoundedFile(_ url: URL, in resources: URL, maximumSize: Int) throws -> Data {
  let resolved = url.resolvingSymlinksInPath()
  guard resolved.path.hasPrefix(resources.resolvingSymlinksInPath().path + "/") else {
    throw HelperError.invalidInput
  }
  let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
  guard values.isRegularFile == true, values.isSymbolicLink != true,
        let size = values.fileSize, size <= maximumSize else { throw HelperError.invalidInput }
  return try Data(contentsOf: url)
}

func codeSigningPolicy() throws -> SecPolicy {
  guard let policy = SecPolicyCreateWithProperties(kSecPolicyAppleCodeSigning, nil) else {
    throw HelperError.securityFailure
  }
  return policy
}

func certificateTrust(_ certificate: SecCertificate) throws -> SecTrust {
  var result: SecTrust?
  guard SecTrustCreateWithCertificates(certificate, try codeSigningPolicy(), &result) == errSecSuccess,
        let trust = result else { throw HelperError.securityFailure }
  guard SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else { throw HelperError.securityFailure }
  return trust
}

func isTrusted(_ certificate: SecCertificate) throws -> Bool {
  // A fresh trust object observes persisted settings after the authorization UI.
  // Never install this certificate as an in-memory anchor to make this pass.
  SecTrustEvaluateWithError(try certificateTrust(certificate), nil)
}

func emit(_ status: String, hash: String) {
  let response: [String: Any] = ["schemaVersion": 1, "status": status, "sha256": hash]
  if let data = try? JSONSerialization.data(withJSONObject: response, options: [.sortedKeys]) {
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
  }
}

func requestConsent(_ certificate: SecCertificate, hash: String) throws -> Bool {
  let app = NSApplication.shared
  app.setActivationPolicy(.accessory)
  app.activate(ignoringOtherApps: true)
  let subject = (SecCertificateCopySubjectSummary(certificate) as String?) ?? "Sliver Desktop developer"
  let displayHash = stride(from: 0, to: hash.count, by: 2).map { offset -> String in
    let start = hash.index(hash.startIndex, offsetBy: offset)
    return String(hash[start..<hash.index(start, offsetBy: 2)])
  }.joined(separator: ":").uppercased()
  while true {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = "Trust the Sliver Desktop update developer?"
    alert.informativeText = "Developer: \(subject)\n\nSHA-256 certificate fingerprint:\n\(displayHash)\n\nThis adds code-signing trust for this certificate to your macOS user account. It permits code signed by this developer to satisfy macOS code-signing trust checks. macOS may ask you to authenticate. Website and TLS trust are not enabled.\n\nThis does not grant Apple notarization or replace macOS installation approval."
    alert.addButton(withTitle: "Trust for Code Signing")
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "View Certificate")
    alert.buttons[0].keyEquivalent = ""
    alert.buttons[1].keyEquivalent = "\r"
    switch alert.runModal() {
    case .alertFirstButtonReturn: return true
    case .alertThirdButtonReturn:
      let panel = SFCertificatePanel.shared()!
      panel.certificateView().setEditableTrust(false)
      panel.setPolicies(try codeSigningPolicy())
      _ = panel.runModal(for: try certificateTrust(certificate), showGroup: false)
    default: return false
    }
  }
}

func installCodeSigningTrust(_ certificate: SecCertificate) throws -> TrustStatus {
  // SecTrustSettingsSetTrustSettings replaces the certificate's user settings.
  // Refuse existing settings so an explicit deny or unrelated policy is never
  // silently removed. Users can resolve those in Keychain Access themselves.
  var existing: CFArray?
  let existingStatus = SecTrustSettingsCopyTrustSettings(certificate, .user, &existing)
  guard existingStatus == errSecItemNotFound || existingStatus == errSecNoTrustSettings else {
    if existingStatus == errSecSuccess { return .required }
    throw HelperError.securityFailure
  }
  let item: [CFString: Any] = [kSecClass: kSecClassCertificate, kSecValueRef: certificate]
  let addStatus = SecItemAdd(item as CFDictionary, nil)
  guard addStatus == errSecSuccess || addStatus == errSecDuplicateItem else {
    if let outcome = authorizationFailureStatus(addStatus) { return outcome }
    throw HelperError.securityFailure
  }
  let setting: [String: Any] = [
    kSecTrustSettingsPolicy: try codeSigningPolicy(),
    kSecTrustSettingsResult: NSNumber(value: SecTrustSettingsResult.trustRoot.rawValue),
  ]
  // Never pass nil/empty settings: those grant trust for every policy. The
  // Security framework performs any authorization required for this user.
  let status = SecTrustSettingsSetTrustSettings(certificate, .user, [setting] as CFArray)
  if let outcome = authorizationFailureStatus(status) { return outcome }
  guard status == errSecSuccess else { throw HelperError.securityFailure }
  return try isTrusted(certificate) ? .trusted : .required
}

var expectedHash = ""
do {
  let arguments = CommandLine.arguments
  guard arguments.count == 3, arguments[1] == "check" || arguments[1] == "request",
        arguments[2].range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
    throw HelperError.invalidInput
  }
  expectedHash = arguments[2]
  let executable = URL(fileURLWithPath: arguments[0]).resolvingSymlinksInPath()
  let resources = executable.deletingLastPathComponent().deletingLastPathComponent()
  guard executable.deletingLastPathComponent().lastPathComponent == "updater-trust" else {
    throw HelperError.invalidInput
  }
  let manifestURL = resources.appendingPathComponent("update-signing/manifest.json")
  let manifest = try JSONDecoder().decode(SigningManifest.self, from: loadBoundedFile(manifestURL, in: resources, maximumSize: 16 * 1024))
  guard manifest.schemaVersion == 1, manifest.macos.sha256 == expectedHash else { throw HelperError.invalidInput }
  let certificateData = try loadBoundedFile(resources.appendingPathComponent("update-signing/macos.cer"), in: resources, maximumSize: 64 * 1024)
  guard fingerprint(certificateData) == expectedHash,
        let certificate = SecCertificateCreateWithData(nil, certificateData as CFData) else {
    throw HelperError.invalidCertificate
  }
  if try isTrusted(certificate) {
    emit("trusted", hash: expectedHash)
  } else if arguments[1] == "check" {
    emit("required", hash: expectedHash)
  } else if try requestConsent(certificate, hash: expectedHash) {
    emit(try installCodeSigningTrust(certificate).rawValue, hash: expectedHash)
  } else {
    emit("cancelled", hash: expectedHash)
  }
} catch {
  emit("error", hash: expectedHash)
  exit(1)
}
