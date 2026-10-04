import Security

enum TrustStatus: String { case trusted, required, cancelled }

func authorizationFailureStatus(_ status: OSStatus) -> TrustStatus? {
  // Keychain APIs and Authorization Services use different error domains.
  // SecTrustSettingsSetTrustSettings propagates AuthorizationCopyRights errors.
  switch status {
  case errSecUserCanceled, errAuthorizationCanceled:
    return .cancelled
  case errSecAuthFailed, errSecInteractionNotAllowed, errAuthorizationDenied, errAuthorizationInteractionNotAllowed:
    return .required
  default:
    return nil
  }
}
