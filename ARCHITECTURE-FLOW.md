# Architecture Flow

State transitions and data flow diagrams for the foundry-agent-webapp application.

## Overview

The app has two distinct state domains:

| Domain | Location | Pattern |
|--------|----------|---------|
| **Frontend** | React (AppContext) | useReducer with discriminated actions |
| **Backend** | ASP.NET Core | Stateless request handling + lazy-cached agent |

---

## Part 1: Backend Flow

### 1.1 Request Pipeline

```mermaid
flowchart TB
    subgraph Middleware["ASP.NET Core Pipeline"]
        direction TB
        A[Incoming Request] --> B{Static File?}
        B -->|Yes| C[UseStaticFiles]
        B -->|No| D[UseCors]
        D --> E[UseAuthentication]
        E --> F[UseAuthorization]
        F --> G{Has Valid JWT?}
        G -->|No| H[401 Unauthorized]
        G -->|Yes| I{Has Chat.ReadWrite Scope?}
        I -->|No| J[403 Forbidden]
        I -->|Yes| K[Route Handler]
    end

    K --> L{Which Endpoint?}
    L -->|/api/chat/stream| M[StreamChatMessage]
    L -->|/api/agent| N[GetAgentMetadata]
    L -->|/api/agent/info| Q[GetAgentInfo]
    L -->|/api/health| O[GetHealth]
    L -->|/*| P[Fallback: index.html]
```

### 1.2 Credential Resolution

```mermaid
stateDiagram-v2
    [*] --> CheckEnvironment

    CheckEnvironment --> Development: ASPNETCORE_ENVIRONMENT = Development
    CheckEnvironment --> Production: Otherwise

    state Development {
        [*] --> ChainedCredential
        ChainedCredential --> TryAzureCli: First
        TryAzureCli --> TryAzdCli: Fallback
        TryAzdCli --> CredentialReady: Success
        TryAzdCli --> CredentialFailed: Both failed
    }

    state Production {
        [*] --> ManagedIdentity
        ManagedIdentity --> CredentialReady: System-assigned
    }

    CredentialReady --> CreateProjectClient
    CredentialFailed --> StartupError
```

### 1.3 Agent Loading (Lazy Singleton)

```mermaid
stateDiagram-v2
    [*] --> NotLoaded: Service instantiated

    NotLoaded --> Loading: First request calls GetAgentAsync
    Loading --> Loading: SemaphoreSlim acquired

    Loading --> Loaded: _projectClient.GetAIAgentAsync success
    Loading --> Failed: Exception thrown

    Loaded --> Loaded: Subsequent requests use _cachedAgent
    Failed --> Loading: Next request retries

    note right of Loaded
        _cachedAgent: ChatClientAgent
        _cachedMetadata: AgentMetadataResponse
        Cached for service lifetime
    end note
```

### 1.4 SSE Streaming Pipeline

```mermaid
sequenceDiagram
    participant Client
    participant Handler as /api/chat/stream
    participant Service as AgentFrameworkService
    participant SDK as ProjectResponsesClient
    participant Agent as AI Foundry

    Client->>Handler: POST ChatRequest
    Handler->>Handler: Set SSE headers

    alt New conversation
        Handler->>Service: CreateConversationAsync
        Service->>SDK: CreateProjectConversationAsync
        SDK-->>Service: conversation.Id
    end

    Handler-->>Client: data: {type: conversationId}

    Handler->>Service: StreamMessageAsync
    Service->>SDK: CreateResponseStreamingAsync

    loop StreamingResponseUpdate
        SDK-->>Service: update

        alt TextDeltaUpdate
            Service-->>Handler: StreamChunk.Text
            Handler-->>Client: data: {type: chunk}
        else ItemDoneUpdate (MessageItem)
            Service->>Service: ExtractAnnotations
            Service-->>Handler: StreamChunk.WithAnnotations
            Handler-->>Client: data: {type: annotations}
        else ItemDoneUpdate (McpApprovalItem)
            Service-->>Handler: StreamChunk.McpApproval
            Handler-->>Client: data: {type: mcpApprovalRequest}
            Note over Client: Stream pauses for user decision
        else CompletedUpdate
            Service->>Service: Store _lastUsage
        else ErrorUpdate
            Service-->>Handler: throw Exception
        end
    end

    Handler->>Service: GetLastUsage
    Handler-->>Client: data: {type: usage}
    Handler-->>Client: data: {type: done}
```

### 1.5 Backend SSE Event Types

| Event Type | When Sent | Payload |
|------------|-----------|---------|
| `conversationId` | First, always | `{conversationId: string}` |
| `chunk` | Per text delta | `{content: string}` |
| `annotations` | After item complete | `{annotations: AnnotationInfo[]}` |
| `mcpApprovalRequest` | MCP tool needs approval | `{approvalRequest: {...}}` |
| `usage` | Before done | `{duration, promptTokens, completionTokens, totalTokens}` |
| `done` | Last, always | `{}` |
| `error` | On exception | `{message: string}` |

---

## Part 2: Frontend State

The frontend manages three state domains:
- **Auth State**: User authentication lifecycle
- **Chat State**: Message and streaming lifecycle  
- **UI State**: Input enablement (derived from chat state)

### 2.1 Authentication State Machine

```mermaid
stateDiagram-v2
    [*] --> initializing

    initializing --> authenticated: AUTH_INITIALIZED
    initializing --> unauthenticated: No cached session

    authenticated --> unauthenticated: AUTH_TOKEN_EXPIRED
    unauthenticated --> authenticated: AUTH_INITIALIZED

    authenticated --> error: Token acquisition fails
    error --> unauthenticated: User dismisses
```

### Auth States

| State | Description | User Object |
|-------|-------------|-------------|
| `initializing` | App startup, checking MSAL cache | `null` |
| `authenticated` | Valid session, user info available | `AccountInfo` |
| `unauthenticated` | No session, login required | `null` |
| `error` | Auth failure (rare) | `null` |

---

### 2.2 Chat State Machine

```mermaid
stateDiagram-v2
    [*] --> idle

    idle --> sending: CHAT_SEND_MESSAGE
    
    sending --> streaming: CHAT_START_STREAM
    sending --> error: CHAT_ERROR

    streaming --> streaming: CHAT_STREAM_CHUNK
    streaming --> streaming: CHAT_STREAM_ANNOTATIONS
    streaming --> idle: CHAT_STREAM_COMPLETE
    streaming --> idle: CHAT_CANCEL_STREAM
    streaming --> idle: CHAT_MCP_APPROVAL_REQUEST
    streaming --> error: CHAT_ERROR

    error --> idle: CHAT_CLEAR_ERROR

    idle --> idle: CHAT_CLEAR
```

### Chat States

| State | Description | Input Enabled | streamingMessageId |
|-------|-------------|---------------|-------------------|
| `idle` | Ready for input | ✅ Yes | `undefined` |
| `sending` | Request in flight | ❌ No | `undefined` |
| `streaming` | Receiving chunks | ❌ No | Message ID |
| `error` | Failure occurred | If recoverable | `undefined` |

---

### 2.3 End-to-End Message Flow

```mermaid
sequenceDiagram
    participant U as User
    participant UI as ChatInterface
    participant R as Reducer
    participant S as ChatService
    participant API as /api/chat/stream
    participant Agent as AI Agent

    U->>UI: Type message + Submit
    UI->>R: CHAT_SEND_MESSAGE
    Note over R: status: sending<br/>messages += userMsg

    UI->>S: streamChat(request)
    S->>API: POST (SSE)
    API->>Agent: CreateConversationAsync

    API-->>S: data: {conversationId}
    S->>R: CHAT_ADD_ASSISTANT_MESSAGE
    S->>R: CHAT_START_STREAM
    Note over R: status: streaming<br/>streamingMessageId = id

    loop Each chunk
        Agent-->>API: StreamingResponse
        API-->>S: data: {type: chunk}
        S->>R: CHAT_STREAM_CHUNK
        Note over R: Append to message content
    end

    alt Annotations received
        API-->>S: data: {type: annotations}
        S->>R: CHAT_STREAM_ANNOTATIONS
    end

    alt MCP Tool Approval needed
        API-->>S: data: {type: mcpApprovalRequest}
        S->>R: CHAT_MCP_APPROVAL_REQUEST
        Note over R: status: idle<br/>Show approval UI
        U->>UI: Approve/Deny
        UI->>S: streamChat (with approval)
        Note over S: Resume streaming
    end

    API-->>S: data: {type: done, usage}
    S->>R: CHAT_STREAM_COMPLETE
    Note over R: status: idle<br/>Input enabled
```

---

### 2.4 MCP Tool Approval Flow

```mermaid
stateDiagram-v2
    [*] --> streaming: Normal streaming

    streaming --> awaiting_approval: CHAT_MCP_APPROVAL_REQUEST
    
    state awaiting_approval {
        [*] --> show_card: Display approval UI
        show_card --> user_decides: User sees tool request
    }

    awaiting_approval --> sending: User approves
    awaiting_approval --> idle: User denies
    
    sending --> streaming: Resume with approval response

    note right of awaiting_approval
        mcpApproval: {
          toolName, arguments,
          previousResponseId
        }
        Input disabled
    end note
```

---

### 2.5 Error Recovery Flow

```mermaid
stateDiagram-v2
    [*] --> active: Normal operation

    active --> error: CHAT_ERROR

    state error {
        [*] --> check_type
        check_type --> recoverable: error.recoverable = true
        check_type --> fatal: error.recoverable = false
    }

    recoverable --> active: CHAT_CLEAR_ERROR
    fatal --> [*]: Page refresh required

    note right of recoverable
        Examples:
        - 401 (token expired)
        - 429 (rate limit)
        - Network timeout
    end note

    note right of fatal
        Examples:
        - Invalid agent config
        - Server 500
    end note
```

---

### 2.6 UI State Derivation

The UI state (`chatInputEnabled`) is derived from chat state:

```mermaid
flowchart LR
    subgraph ChatStatus
        idle[idle]
        sending[sending]
        streaming[streaming]
        error[error]
    end

    subgraph InputEnabled
        yes[✅ Enabled]
        no[❌ Disabled]
        maybe[⚠️ Conditional]
    end

    idle --> yes
    sending --> no
    streaming --> no
    error --> maybe

    maybe --> yes
    maybe --> no

    note1[/"recoverable = true"/] --> yes
    note2[/"recoverable = false"/] --> no
```

---

### 2.7 Action Reference

| Action | From State(s) | To State | Side Effects |
|--------|--------------|----------|--------------|
| `AUTH_INITIALIZED` | initializing, unauthenticated | authenticated | Set user object |
| `AUTH_TOKEN_EXPIRED` | authenticated | unauthenticated | Clear user |
| `CHAT_SEND_MESSAGE` | idle | sending | Append user message |
| `CHAT_ADD_ASSISTANT_MESSAGE` | sending | sending | Create empty assistant msg |
| `CHAT_START_STREAM` | sending | streaming | Set conversationId, messageId |
| `CHAT_STREAM_CHUNK` | streaming | streaming | Append content to msg |
| `CHAT_STREAM_ANNOTATIONS` | streaming | streaming | Add citations to msg |
| `CHAT_MCP_APPROVAL_REQUEST` | streaming | idle | Add approval message, keep input disabled |
| `CHAT_STREAM_COMPLETE` | streaming | idle | Add usage, enable input |
| `CHAT_CANCEL_STREAM` | streaming | idle | Enable input |
| `CHAT_ERROR` | any | error | Set error, conditional input |
| `CHAT_CLEAR_ERROR` | error | idle | Clear error, enable input |
| `CHAT_CLEAR` | any | idle | Reset all chat state |

### 2.8 SSE Event → Action Mapping

The `ChatService` translates backend SSE events into reducer actions:

| SSE Event | Action Dispatched | Payload Transformation |
|-----------|-------------------|----------------------|
| `conversationId` | `CHAT_START_STREAM` | Extract `conversationId` from event |
| `chunk` | `CHAT_STREAM_CHUNK` | Extract `content` field |
| `annotations` | `CHAT_STREAM_ANNOTATIONS` | Map `AnnotationInfo[]` to `IAnnotation[]` |
| `mcpApprovalRequest` | `CHAT_MCP_APPROVAL_REQUEST` | Create approval message with `role: 'approval'` |
| `usage` | `CHAT_STREAM_COMPLETE` | Extract token counts and duration |
| `done` | `CHAT_STREAM_COMPLETE` | Finalize if no usage event received |
| `error` | `CHAT_ERROR` | Wrap message in `AppError` object |

---

## Part 3: Performance Patterns

### 3.1 Reducer Optimizations

**Early Returns**: Return same state reference when no changes occur to prevent unnecessary re-renders:

```typescript
case 'CHAT_STREAM_CHUNK': {
  const messageIndex = state.chat.messages.findIndex(
    msg => msg.id === action.messageId
  );
  
  if (messageIndex === -1) {
    return state; // Reference equality preserved - no re-render
  }
  // ...
}
```

**Targeted Array Updates**: Only recreate the modified message object:

```typescript
const updatedMessages = [...state.chat.messages];
updatedMessages[messageIndex] = {
  ...updatedMessages[messageIndex],
  content: updatedMessages[messageIndex].content + action.content,
};
```

This preserves reference equality for all other messages, preventing their components from re-rendering.

### 3.2 Development Logging

In development mode, the `AppContext` logs each action with state changes:

```
🔄 [14:32:01] CHAT_STREAM_CHUNK
Action: { type: 'CHAT_STREAM_CHUNK', messageId: '...', content: 'Hello' }
Changes: { 'chat.messages[2].content': 'He → Hello' }
```

Enable via: `import.meta.env.DEV` (automatic in Vite dev server).

---

## Part 4: Extending the State

### Adding a New Action

**Step 1**: Define the action type in `frontend/src/types/appState.ts`:

```typescript
export type AppAction = 
  // ... existing actions
  | { type: 'MY_NEW_ACTION'; payload: MyPayloadType }
```

**Step 2**: Handle in reducer `frontend/src/reducers/appReducer.ts`:

```typescript
case 'MY_NEW_ACTION':
  return {
    ...state,
    targetDomain: {
      ...state.targetDomain,
      field: action.payload,
    },
  };
```

**Step 3**: Dispatch from service or component:

```typescript
// In ChatService or component
dispatch({ type: 'MY_NEW_ACTION', payload: data });
```

**Step 4**: Consume in UI (automatic re-render):

```typescript
const { state } = useAppContext();
const value = state.targetDomain.field; // Updates on action
```

---

## Part 5: Backend Patterns

### 5.1 Attachment Validation

The backend enforces strict validation on file attachments before sending to AI Foundry:

**Image Limits**:

| Rule | Limit | Error |
|------|-------|-------|
| Max images per request | 5 | HTTP 400 |
| Max size per image | 5 MB (decoded) | HTTP 400 |
| Allowed MIME types | `image/png`, `image/jpeg`, `image/gif`, `image/webp` | HTTP 400 |

**Document Limits**:

| Rule | Limit | Error |
|------|-------|-------|
| Max files per request | 10 | HTTP 400 |
| Max size per file | 20 MB (decoded) | HTTP 400 |
| Allowed types | PDF, plain text, markdown, CSV, JSON, HTML, XML | HTTP 400 |
| Unsupported | DOCX, PPTX, XLSX (Office documents) | HTTP 400 |

Validation occurs in `BuildUserMessage()` before constructing the AI Foundry message payload.

### 5.2 Error Response Format (RFC 7807)

All API errors use standardized Problem Details format:

```json
{
  "title": "Authentication Failed",
  "status": 401,
  "detail": "Token expired at 2026-01-20T14:30:00Z",
  "traceId": "00-abc123..."
}
```

| Field | Type | Description |
|-------|------|-------------|
| `title` | string | Human-readable error summary |
| `status` | int | HTTP status code |
| `detail` | string | Specific error description |
| `traceId` | string? | Request correlation ID |
| `stackTrace` | string? | Exception stack (dev only, omitted in prod) |

### 5.3 Async Patterns

The backend follows strict async/await conventions:

**✅ Do**:
- Use `async`/`await` with `CancellationToken` on all I/O
- Pass `CancellationToken` through the entire call chain
- Use `IAsyncEnumerable<T>` for streaming responses
- Include `[EnumeratorCancellation]` attribute on streaming parameters

**❌ Don't**:
- Call `.Result` or `.Wait()` on async methods (causes deadlocks)
- Ignore `CancellationToken` parameters
- Use synchronous I/O in async contexts
- Block on async code in constructors

### 5.4 Configuration Keys

| Key | Source | Purpose | Example |
|-----|--------|---------|---------|
| `AzureAd:ClientId` | .env | Entra app client ID | `abc123-...` |
| `AzureAd:TenantId` | .env | Entra tenant ID | `def456-...` |
| `AI_AGENT_ENDPOINT` | .env | AI Foundry project URL | `https://....api.azureml.ms` |
| `AI_AGENT_ID` | .env | Agent name (v2 API) | `my-agent` |
| `ASPNETCORE_ENVIRONMENT` | Environment | Development/Production | `Development` |

The `.env` file is auto-generated by `postprovision.ps1` during `azd up` (after Bicep provisions the Entra app and infrastructure).

---

## Part 6: File Reference

### Backend

| File | Purpose |
|------|---------|
| [backend/WebApp.Api/Program.cs](backend/WebApp.Api/Program.cs) | Request pipeline, JWT validation, SSE endpoints |
| [backend/WebApp.Api/Services/AgentFrameworkService.cs](backend/WebApp.Api/Services/AgentFrameworkService.cs) | Agent loading, streaming, credential management |
| [backend/WebApp.Api/Models/StreamChunk.cs](backend/WebApp.Api/Models/StreamChunk.cs) | SSE chunk types (text, annotations, MCP) |
| [backend/WebApp.Api/Models/ChatRequest.cs](backend/WebApp.Api/Models/ChatRequest.cs) | Request payload with attachments |

### Frontend

| File | Purpose |
|------|---------|
| [frontend/src/types/appState.ts](frontend/src/types/appState.ts) | State & action type definitions |
| [frontend/src/reducers/appReducer.ts](frontend/src/reducers/appReducer.ts) | Pure reducer with all transitions |
| [frontend/src/contexts/AppContext.tsx](frontend/src/contexts/AppContext.tsx) | Provider with MSAL integration |
| [frontend/src/services/chatService.ts](frontend/src/services/chatService.ts) | SSE client dispatching actions |
