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

    func createSession() async throws -> SessionMutationResponse {
        try await request("api/sessions", method: "POST", body: EmptyBody())
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

    func codexSessions(limit: Int) async throws -> CodexSessionsResponse {
        try await request("api/codex/sessions?limit=\(limit)&refresh=1")
    }

    func resumeCodexSession(_ id: String, terminalSessionId: String?) async throws {
        _ = try await requestData(
            "api/codex/sessions/\(id)/resume",
            method: "POST",
            body: ResumeRequest(terminalSessionId: terminalSessionId)
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

    private func request<T: Decodable>(_ path: String) async throws -> T {
        let data = try await requestData(path, method: "GET", body: Optional<EmptyBody>.none)
        guard !data.isEmpty else {
            throw APIError.emptyResponse
        }
        return try decoder.decode(T.self, from: data)
    }

    private func request<T: Decodable, Body: Encodable>(_ path: String, method: String, body: Body) async throws -> T {
        let data = try await requestData(path, method: method, body: body)
        guard !data.isEmpty else {
            throw APIError.emptyResponse
        }
        return try decoder.decode(T.self, from: data)
    }

    private func requestData<Body: Encodable>(_ path: String, method: String, body: Body?) async throws -> Data {
        guard let url = makeURL(path) else {
            throw APIError.invalidBaseURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")

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

private struct CommandRequest: Encodable {
    let command: String
}

private struct ResumeRequest: Encodable {
    let terminalSessionId: String?
}

private struct ErrorResponse: Decodable {
    let error: String
}
