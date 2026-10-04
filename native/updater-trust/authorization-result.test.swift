import Security

@main
struct AuthorizationResultTests {
  static func main() {
    for status in [errSecUserCanceled, errAuthorizationCanceled] {
      precondition(authorizationFailureStatus(status) == .cancelled,
                   "Explicit cancellation must remain distinct from authorization denial")
    }
    for status in [errSecAuthFailed, errSecInteractionNotAllowed, errAuthorizationDenied, errAuthorizationInteractionNotAllowed] {
      precondition(authorizationFailureStatus(status) == .required,
                   "Denied or unavailable authorization must leave trust required")
    }
    for status in [errSecSuccess, errSecParam, errSecNotAvailable, errSecInternalComponent] {
      precondition(authorizationFailureStatus(status) == nil,
                   "Unknown failures and success must not be remapped to authorization outcomes")
    }
  }
}
