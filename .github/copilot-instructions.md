Azure AI Foundry Agent Service sample app — Entra ID auth, SSE streaming, Container Apps deployment.

## Architecture

| Layer | Tech | Port | Entry Point |
|-------|------|------|-------------|
| **Frontend** | React 19 + Vite | 5173 | `frontend/src/App.tsx` |
| **Backend** | ASP.NET Core 9 | 8080 | `backend/WebApp.Api/Program.cs` |
| **Auth** | MSAL.js → JWT Bearer | — | `frontend/src/config/authConfig.ts` |
| **AI SDK** | Azure.AI.Projects + Agent Framework | — | `backend/.../AgentFrameworkService.cs` |
| **Deploy** | Azure Container Apps | — | `infra/main.bicep` |

**Key Flow**: React → MSAL token → POST /api/chat/stream → AI Foundry → SSE chunks → UI

## Why These Decisions

- **Single container** — Backend serves API (`/api/*`) and React SPA from `wwwroot`. Avoids CORS, simplifies Container Apps to one resource. Don't split it.
- **ChainedTokenCredential** — `DefaultAzureCredential` tries ~8 sources with slow timeouts. `ChainedTokenCredential(AzureCliCredential, ManagedIdentityCredential)` is predictable. Auth hanging 30+ seconds = someone used `DefaultAzureCredential`.
- **ACR admin credentials** — Managed identity ACR pull creates chicken-and-egg: Container App needs acrPull role but the identity doesn't exist until provisioned. Admin credentials via `listCredentials()` avoid this. Production apps should use a user-assigned managed identity created before the Container App.
- **`.npmrc` handles `--legacy-peer-deps`** — React 19 peer-dep conflicts. Run `npm install` from `frontend/` directory.

## Deployment (Non-Obvious)

`azd up` phases: **preprovision** → **provision** (Bicep) → **postprovision** → **predeploy** → **deploy**

**What's intentionally CLI (not Bicep)**:
- **Entra redirect URI + identifierUri update** — Entra app is created by Bicep (`infra/entra-app.bicep`), but `identifierUri` (`api://{appId}`) can't reference the auto-generated `appId` in the same declaration, and redirect URIs need the Container App FQDN which isn't available until after provision. Both are set in `postprovision.ps1`.
- **AI Foundry discovery** — Discovers user's *existing* external AI Foundry resource via `az cognitiveservices account list`. This is a data-plane discovery operation, not resource deployment.
- **Cross-RG RBAC** — Done via CLI so `azd down` only deletes our resource group, not the external AI Foundry resources.
- **Entra app deletion** — Microsoft Graph resources are not tied to Azure resource groups; `azd down` (which deletes the RG) won't clean them up. `postdown.ps1` handles this.

**Health probes** are conditional: disabled when placeholder image is deployed (first provision), enabled when real image exists.

**Service Management Reference**: Some orgs (notably Microsoft) require this on Entra app registrations. Set via `azd env set ENTRA_SERVICE_MANAGEMENT_REFERENCE <guid>` before running `azd up`; Bicep passes it to the Microsoft Graph extension.

## Development

```powershell
# Ctrl+Shift+B → "Start Dev (VS Code Terminals)"
# Or: azd up
```

## Hooks

| Hook | Event | What It Does |
|------|-------|-------------|
| **Commit Gate** | `preToolUse` | Blocks direct `git commit`. Follow `committing-code` skill → commit via `-F COMMIT_MESSAGE.md`. |
| **Test Reminder** | `preToolUse` | Advisory: reminds to run tests if test files exist for staged changes. |
| **Doc Sync** | `postToolUse` | Reminds to update `ARCHITECTURE-FLOW.md` when architecture-sensitive files are edited. |
