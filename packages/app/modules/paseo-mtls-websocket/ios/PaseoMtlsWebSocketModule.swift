import ExpoModulesCore
import Foundation
import Security

private let socketOpenEventName = "onSocketOpen"
private let socketMessageEventName = "onSocketMessage"
private let socketCloseEventName = "onSocketClose"
private let socketErrorEventName = "onSocketError"
private weak var activeModule: PaseoMtlsWebSocketModule?

private final class PaseoMtlsError: Error, CustomStringConvertible {
  let description: String

  init(_ description: String) {
    self.description = description
  }
}

private struct StoredIdentityRecord: Codable {
  let pkcs12Base64: String
  let password: String
  let displayName: String?
  let subjectSummary: String?
  let expiresAt: String?
  let importedAt: String
}

private func bridgeDictionary(_ values: [String: Any?]) -> [String: Any] {
  var bridged: [String: Any] = [:]
  bridged.reserveCapacity(values.count)
  for (key, value) in values {
    bridged[key] = value ?? NSNull()
  }
  return bridged
}

private final class PaseoMtlsIdentityStore {
  static let shared = PaseoMtlsIdentityStore()

  private init() {}

  func importPkcs12(base64: String, password: String, fileName: String?) throws -> [String: Any] {
    guard !password.isEmpty else {
      throw PaseoMtlsError("Enter the PKCS#12 password before importing")
    }
    let record = try createIdentityRecord(base64: base64, password: password, fileName: fileName)
    let identityId = UUID().uuidString
    try saveIdentityRecord(identityId: identityId, record: record)
    return metadataPayload(identityId: identityId, record: record)
  }

  func deleteIdentity(identityId: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "sh.paseo.mtls.identity",
      kSecAttrAccount as String: identityId,
    ]
    let status = SecItemDelete(query as CFDictionary)
    if status == errSecItemNotFound || status == errSecSuccess {
      return
    }
    throw PaseoMtlsError("Failed to delete imported client certificate")
  }

  func getIdentityMetadata(identityId: String) throws -> [String: Any]? {
    guard let record = try loadIdentityRecord(identityId: identityId) else {
      return nil
    }
    return metadataPayload(identityId: identityId, record: record)
  }

  func resolveIdentity(identityId: String) throws -> SecIdentity {
    guard let record = try loadIdentityRecord(identityId: identityId) else {
      throw PaseoMtlsError("Imported client certificate is missing")
    }
    let importItem = try importIdentity(from: Data(base64Encoded: record.pkcs12Base64) ?? Data(), password: record.password)
    return importItem.identity
  }

  private func createIdentityRecord(base64: String, password: String, fileName: String?) throws -> StoredIdentityRecord {
    guard let data = Data(base64Encoded: base64) else {
      throw PaseoMtlsError("Choose a .p12 or .pfx client certificate file")
    }
    let importItem = try importIdentity(from: data, password: password)
    let certificate = importItem.certificate
    let displayName = fileName?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
      ? fileName?.trimmingCharacters(in: .whitespacesAndNewlines)
      : nil
    let subjectSummary = SecCertificateCopySubjectSummary(certificate) as String?
    let expiresAt = expirationDateIsoString(for: certificate)
    return StoredIdentityRecord(
      pkcs12Base64: base64,
      password: password,
      displayName: displayName,
      subjectSummary: subjectSummary,
      expiresAt: expiresAt,
      importedAt: ISO8601DateFormatter().string(from: Date())
    )
  }

  private func importIdentity(from data: Data, password: String) throws -> (identity: SecIdentity, certificate: SecCertificate) {
    var result: CFArray?
    let options = [kSecImportExportPassphrase as String: password]
    let status = SecPKCS12Import(data as CFData, options as CFDictionary, &result)
    guard status == errSecSuccess,
          let items = result as? [[String: Any]],
          let firstItem = items.first,
          let identity = firstItem[kSecImportItemIdentity as String] as? SecIdentity else {
      throw PaseoMtlsError("Unable to import the client certificate")
    }
    var certificate: SecCertificate?
    let copyStatus = SecIdentityCopyCertificate(identity, &certificate)
    guard copyStatus == errSecSuccess, let certificate else {
      throw PaseoMtlsError("Unable to read the imported client certificate")
    }
    return (identity, certificate)
  }

  private func saveIdentityRecord(identityId: String, record: StoredIdentityRecord) throws {
    let payload = try JSONEncoder().encode(record)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "sh.paseo.mtls.identity",
      kSecAttrAccount as String: identityId,
      kSecValueData as String: payload,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw PaseoMtlsError("Unable to persist the imported client certificate")
    }
  }

  private func loadIdentityRecord(identityId: String) throws -> StoredIdentityRecord? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "sh.paseo.mtls.identity",
      kSecAttrAccount as String: identityId,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess,
          let data = result as? Data else {
      throw PaseoMtlsError("Unable to load the imported client certificate")
    }
    return try JSONDecoder().decode(StoredIdentityRecord.self, from: data)
  }

  private func metadataPayload(identityId: String, record: StoredIdentityRecord) -> [String: Any] {
    return bridgeDictionary([
      "identityId": identityId,
      "displayName": record.displayName,
      "subjectSummary": record.subjectSummary,
      "expiresAt": record.expiresAt,
      "importedAt": record.importedAt,
    ])
  }

  private func expirationDateIsoString(for certificate: SecCertificate) -> String? {
    let keys = [kSecOIDX509V1ValidityNotAfter] as CFArray
    guard let values = SecCertificateCopyValues(certificate, keys, nil) as? [CFString: Any],
          let entry = values[kSecOIDX509V1ValidityNotAfter] as? [CFString: Any],
          let value = entry[kSecPropertyKeyValue] as? Date else {
      return nil
    }
    return ISO8601DateFormatter().string(from: value)
  }
}

private final class PaseoMtlsSocket: NSObject, URLSessionDelegate, URLSessionTaskDelegate, URLSessionWebSocketDelegate {
  private let socketId: String
  private let identityId: String
  private let request: URLRequest
  private var session: URLSession?
  private var task: URLSessionWebSocketTask?
  private var closed = false

  init(socketId: String, identityId: String, request: URLRequest) {
    self.socketId = socketId
    self.identityId = identityId
    self.request = request
  }

  func connect() {
    let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
    let task = session.webSocketTask(with: request)
    self.session = session
    self.task = task
    task.resume()
    receiveNextMessage()
  }

  func sendString(_ data: String) async throws {
    guard let task else {
      throw PaseoMtlsError("mTLS direct connection is not open")
    }
    try await task.send(.string(data))
  }

  func sendBinary(_ data: Data) async throws {
    guard let task else {
      throw PaseoMtlsError("mTLS direct connection is not open")
    }
    try await task.send(.data(data))
  }

  func close(code: Int?, reason: String?) {
    closed = true
    let closeCode = URLSessionWebSocketTask.CloseCode(rawValue: code ?? URLSessionWebSocketTask.CloseCode.normalClosure.rawValue)
      ?? .normalClosure
    let reasonData = reason?.data(using: .utf8)
    task?.cancel(with: closeCode, reason: reasonData)
    session?.invalidateAndCancel()
    task = nil
    session = nil
  }

  private func receiveNextMessage() {
    guard let task else {
      return
    }
    task.receive { [weak self] result in
      guard let self else {
        return
      }
      switch result {
      case .success(.string(let text)):
        emitMtlsSocketMessage([
          "socketId": self.socketId,
          "type": "string",
          "text": text,
        ])
        self.receiveNextMessage()
      case .success(.data(let data)):
        emitMtlsSocketMessage([
          "socketId": self.socketId,
          "type": "binary",
          "base64": data.base64EncodedString(),
        ])
        self.receiveNextMessage()
      case .failure(let error):
        if self.closed {
          return
        }
        self.closed = true
        emitMtlsSocketError([
          "socketId": self.socketId,
          "message": error.localizedDescription,
        ])
        emitMtlsSocketClose([
          "socketId": self.socketId,
          "code": 0,
          "reason": error.localizedDescription,
        ])
        PaseoMtlsSocketRegistry.shared.remove(socketId: self.socketId)
      @unknown default:
        break
      }
    }
  }

  func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge, completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodClientCertificate {
      do {
        let identity = try PaseoMtlsIdentityStore.shared.resolveIdentity(identityId: identityId)
        let credential = URLCredential(identity: identity, certificates: nil, persistence: .forSession)
        completionHandler(.useCredential, credential)
      } catch {
        completionHandler(.cancelAuthenticationChallenge, nil)
      }
      return
    }

    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
       let trust = challenge.protectionSpace.serverTrust {
      completionHandler(.performDefaultHandling, URLCredential(trust: trust))
      return
    }

    completionHandler(.performDefaultHandling, nil)
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
    emitMtlsSocketOpen([
      "socketId": socketId,
      "negotiatedProtocol": `protocol`,
    ])
  }

  func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
    closed = true
    emitMtlsSocketClose([
      "socketId": socketId,
      "code": Int(closeCode.rawValue),
      "reason": reason.flatMap { String(data: $0, encoding: .utf8) } ?? "",
    ])
    PaseoMtlsSocketRegistry.shared.remove(socketId: socketId)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let error, !closed else {
      return
    }
    closed = true
    emitMtlsSocketError([
      "socketId": socketId,
      "message": error.localizedDescription,
    ])
    emitMtlsSocketClose([
      "socketId": socketId,
      "code": 0,
      "reason": error.localizedDescription,
    ])
    PaseoMtlsSocketRegistry.shared.remove(socketId: socketId)
  }
}

private final class PaseoMtlsSocketRegistry {
  static let shared = PaseoMtlsSocketRegistry()

  private let queue = DispatchQueue(label: "sh.paseo.mtls.socket-registry")
  private var sockets: [String: PaseoMtlsSocket] = [:]

  private init() {}

  func connect(socketId: String, url: String, identityId: String, headers: [String: String]?, protocols: [String]?) throws {
    guard let endpoint = URL(string: url) else {
      throw PaseoMtlsError("Invalid direct connection URL")
    }
    var request = URLRequest(url: endpoint)
    request.timeoutInterval = 30
    headers?.forEach { request.setValue($1, forHTTPHeaderField: $0) }
    if let protocols, !protocols.isEmpty {
      request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol")
    }
    let socket = PaseoMtlsSocket(socketId: socketId, identityId: identityId, request: request)
    queue.sync {
      sockets[socketId]?.close(code: nil, reason: "replaced")
      sockets[socketId] = socket
    }
    socket.connect()
  }

  func sendString(socketId: String, data: String) async throws {
    let socket = try requireSocket(socketId: socketId)
    try await socket.sendString(data)
  }

  func sendBinary(socketId: String, base64: String) async throws {
    guard let data = Data(base64Encoded: base64) else {
      throw PaseoMtlsError("Invalid binary socket payload")
    }
    let socket = try requireSocket(socketId: socketId)
    try await socket.sendBinary(data)
  }

  func close(socketId: String, code: Int?, reason: String?) {
    queue.sync {
      let socket = sockets.removeValue(forKey: socketId)
      socket?.close(code: code, reason: reason)
    }
  }

  func remove(socketId: String) {
    queue.sync {
      sockets.removeValue(forKey: socketId)
    }
  }

  func closeAll() {
    queue.sync {
      let activeSockets = Array(sockets.values)
      sockets.removeAll()
      activeSockets.forEach { $0.close(code: nil, reason: "module destroyed") }
    }
  }

  private func requireSocket(socketId: String) throws -> PaseoMtlsSocket {
    try queue.sync {
      guard let socket = sockets[socketId] else {
        throw PaseoMtlsError("mTLS direct connection is not open")
      }
      return socket
    }
  }
}

private func emitMtlsSocketOpen(_ payload: [String: Any]) {
  DispatchQueue.main.async {
    activeModule?.sendEvent(socketOpenEventName, payload)
  }
}

private func emitMtlsSocketMessage(_ payload: [String: Any]) {
  DispatchQueue.main.async {
    activeModule?.sendEvent(socketMessageEventName, payload)
  }
}

private func emitMtlsSocketClose(_ payload: [String: Any]) {
  DispatchQueue.main.async {
    activeModule?.sendEvent(socketCloseEventName, payload)
  }
}

private func emitMtlsSocketError(_ payload: [String: Any]) {
  DispatchQueue.main.async {
    activeModule?.sendEvent(socketErrorEventName, payload)
  }
}

public final class PaseoMtlsWebSocketModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoMtlsWebSocket")

    Events(socketOpenEventName, socketMessageEventName, socketCloseEventName, socketErrorEventName)

    OnCreate {
      activeModule = self
    }

    AsyncFunction("importPkcs12") { (base64: String, password: String, fileName: String?) -> [String: Any] in
      return try PaseoMtlsIdentityStore.shared.importPkcs12(base64: base64, password: password, fileName: fileName)
    }

    AsyncFunction("deleteIdentity") { (identityId: String) in
      try PaseoMtlsIdentityStore.shared.deleteIdentity(identityId: identityId)
    }

    AsyncFunction("getIdentityMetadata") { (identityId: String) -> [String: Any]? in
      return try PaseoMtlsIdentityStore.shared.getIdentityMetadata(identityId: identityId)
    }

    AsyncFunction("connect") { (socketId: String, url: String, identityId: String, headers: [String: String]?, protocols: [String]?) in
      try PaseoMtlsSocketRegistry.shared.connect(socketId: socketId, url: url, identityId: identityId, headers: headers, protocols: protocols)
    }

    AsyncFunction("sendString") { (socketId: String, data: String) in
      try await PaseoMtlsSocketRegistry.shared.sendString(socketId: socketId, data: data)
    }

    AsyncFunction("sendBinary") { (socketId: String, base64: String) in
      try await PaseoMtlsSocketRegistry.shared.sendBinary(socketId: socketId, base64: base64)
    }

    AsyncFunction("close") { (socketId: String, code: Int?, reason: String?) in
      PaseoMtlsSocketRegistry.shared.close(socketId: socketId, code: code, reason: reason)
    }

    OnDestroy {
      PaseoMtlsSocketRegistry.shared.closeAll()
      if activeModule === self {
        activeModule = nil
      }
    }
  }
}
