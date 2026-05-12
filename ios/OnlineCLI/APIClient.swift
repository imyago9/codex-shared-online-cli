import Foundation

enum APIError: LocalizedError {
    case invalidBaseURL
    case badStatus(Int, String)
    case emptyResponse

    var errorDescription: String? {
        switch self {
        case .invalidBaseURL:
            return "Invalid tailnet URL"
        case .badStatus(let status, let message):
            return message.isEmpty ? "Request failed (\(status))" : message
        case .emptyResponse:
            return "The server returned an empty response"
        }
    }
}

enum TailscaleAPIError: LocalizedError {
    case invalidRequest
    case badStatus(Int, String)
    case missingToken

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            return "Invalid Tailscale OAuth settings"
        case .badStatus(let status, let message):
            return message.isEmpty ? "Tailscale request failed (\(status))" : message
        case .missingToken:
            return "Tailscale did not return an access token"
        }
    }
}

struct TailscaleAPI {
    private let baseURL = URL(string: "https://api.tailscale.com")!
    private let decoder = JSONDecoder()

    func fetchDevices(tailnet: String, clientID: String, clientSecret: String) async throws -> [TailscaleDevice] {
        let token = try await fetchAccessToken(clientID: clientID, clientSecret: clientSecret)
        return try await fetchDevices(tailnet: tailnet, accessToken: token)
    }

    private func fetchAccessToken(clientID: String, clientSecret: String) async throws -> String {
        let trimmedClientID = ServerSettings.normalizedOAuthClientID(clientID)
        let trimmedSecret = clientSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
            !trimmedClientID.isEmpty,
            !trimmedSecret.isEmpty,
            let tokenURL = URL(string: "/api/v2/oauth/token", relativeTo: baseURL)
        else {
            throw TailscaleAPIError.invalidRequest
        }

        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "grant_type", value: "client_credentials"),
            URLQueryItem(name: "scope", value: "devices:core:read")
        ]

        guard let body = form.percentEncodedQuery?.data(using: .utf8) else {
            throw TailscaleAPIError.invalidRequest
        }

        var request = URLRequest(url: tokenURL)
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")

        let credentials = "\(trimmedClientID):\(trimmedSecret)"
        guard let credentialsData = credentials.data(using: .utf8) else {
            throw TailscaleAPIError.invalidRequest
        }
        request.setValue("Basic \(credentialsData.base64EncodedString())", forHTTPHeaderField: "authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)

        let token = try decoder.decode(TailscaleOAuthTokenResponse.self, from: data)
        let accessToken = token.accessToken.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !accessToken.isEmpty else {
            throw TailscaleAPIError.missingToken
        }
        return accessToken
    }

    private func fetchDevices(tailnet: String, accessToken: String) async throws -> [TailscaleDevice] {
        let normalizedTailnet = ServerSettings.normalizedTailnetName(tailnet)
        let allowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))
        guard
            let encodedTailnet = normalizedTailnet.addingPercentEncoding(withAllowedCharacters: allowed),
            let devicesURL = URL(string: "/api/v2/tailnet/\(encodedTailnet)/devices", relativeTo: baseURL)
        else {
            throw TailscaleAPIError.invalidRequest
        }

        var request = URLRequest(url: devicesURL)
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "authorization")

        let (data, response) = try await URLSession.shared.data(for: request)
        try validate(response: response, data: data)

        let devicesResponse = try decoder.decode(TailscaleDevicesResponse.self, from: data)
        return devicesResponse.devices.sorted { lhs, rhs in
            lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName) == .orderedAscending
        }
    }

    private func validate(response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            return
        }

        guard (200..<300).contains(http.statusCode) else {
            let message = (try? decoder.decode(TailscaleErrorResponse.self, from: data).message)
                ?? (try? decoder.decode(ErrorResponse.self, from: data).error)
                ?? ""
            throw TailscaleAPIError.badStatus(http.statusCode, message)
        }
    }
}

private struct TailscaleOAuthTokenResponse: Decodable {
    let accessToken: String

    enum CodingKeys: String, CodingKey {
        case accessToken = "access_token"
    }
}

private struct TailscaleErrorResponse: Decodable {
    let message: String?
}

struct OnlineCLIAPI {
    let baseURL: URL
    private let decoder = JSONDecoder()
    private let encoder = JSONEncoder()

    init(baseURL: URL) {
        self.baseURL = baseURL
    }

    func health() async throws -> HealthResponse {
        try await request("api/health")
    }

    func sessions() async throws -> SessionsResponse {
        try await request("api/sessions")
    }

    func createSession(name: String? = nil, terminalProfile: TerminalProfile? = nil) async throws -> SessionMutationResponse {
        try await request(
            "api/sessions",
            method: "POST",
            body: CreateSessionRequest(name: name, terminalProfile: terminalProfile)
        )
    }

    func restartSession(_ id: String) async throws -> SessionMutationResponse {
        try await request("api/sessions/\(id)/restart", method: "POST", body: EmptyBody())
    }

    func deleteSession(_ id: String) async throws {
        _ = try await requestData("api/sessions/\(id)", method: "DELETE", body: Optional<EmptyBody>.none)
    }

    func sendCommand(_ command: String, sessionId: String) async throws {
        _ = try await requestData(
            "api/sessions/\(sessionId)/command",
            method: "POST",
            body: CommandRequest(command: command)
        )
    }

    func scrollSession(_ sessionId: String, lines: Int) async throws {
        _ = try await requestData(
            "api/sessions/\(sessionId)/scroll",
            method: "POST",
            body: ScrollRequest(lines: lines)
        )
    }

    func remoteStatus() async throws -> RemoteStatus {
        try await request("api/remote/status")
    }

    func remoteCapabilities() async throws -> RemoteCapabilities {
        try await request("api/remote/capabilities")
    }

    func webSocketURL(path: String, queryItems: [URLQueryItem] = []) throws -> URL {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            throw APIError.invalidBaseURL
        }
        components.scheme = components.scheme == "http" ? "ws" : "wss"
        components.path = normalizedPath(path)
        components.queryItems = queryItems.isEmpty ? nil : queryItems
        guard let url = components.url else {
            throw APIError.invalidBaseURL
        }
        return url
    }

    private func request<T: Decodable>(_ path: String, authToken: String? = nil) async throws -> T {
        let data = try await requestData(path, method: "GET", body: Optional<EmptyBody>.none, authToken: authToken)
        guard !data.isEmpty else {
            throw APIError.emptyResponse
        }
        return try decoder.decode(T.self, from: data)
    }

    private func request<T: Decodable, Body: Encodable>(
        _ path: String,
        method: String,
        body: Body,
        authToken: String? = nil
    ) async throws -> T {
        let data = try await requestData(path, method: method, body: body, authToken: authToken)
        guard !data.isEmpty else {
            throw APIError.emptyResponse
        }
        return try decoder.decode(T.self, from: data)
    }

    private func requestData<Body: Encodable>(
        _ path: String,
        method: String,
        body: Body?,
        authToken: String? = nil
    ) async throws -> Data {
        guard let url = makeURL(path) else {
            throw APIError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        if let authToken = authToken?.trimmingCharacters(in: .whitespacesAndNewlines), !authToken.isEmpty {
            request.setValue("Bearer \(authToken)", forHTTPHeaderField: "authorization")
        }

        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try encoder.encode(body)
        }

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            return data
        }

        guard (200..<300).contains(http.statusCode) else {
            let message = (try? JSONDecoder().decode(ErrorResponse.self, from: data).error) ?? ""
            throw APIError.badStatus(http.statusCode, message)
        }
        return data
    }

    private func makeURL(_ path: String) -> URL? {
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else {
            return nil
        }
        let rawPath = normalizedPath(path)
        if let queryStart = rawPath.firstIndex(of: "?") {
            components.path = String(rawPath[..<queryStart])
            components.query = String(rawPath[rawPath.index(after: queryStart)...])
        } else {
            components.path = rawPath
        }
        return components.url
    }

    private func normalizedPath(_ path: String) -> String {
        "/" + path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
    }
}

private struct EmptyBody: Encodable {}

private struct CreateSessionRequest: Encodable {
    let name: String?
    let terminalProfile: TerminalProfile?
}

private struct CommandRequest: Encodable {
    let command: String
}

private struct ScrollRequest: Encodable {
    let lines: Int
}

private struct ErrorResponse: Decodable {
    let error: String
}
