extension microsoftGraphV1

@description('Name suffix for the Entra app (e.g., environment name)')
param environmentName string

@description('Service Management Reference GUID (required by some orgs)')
param serviceManagementReference string = ''

// Deterministic scope ID — stable across redeployments
var chatReadWriteScopeId = guid(resourceGroup().id, environmentName, 'Chat.ReadWrite')

resource app 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: 'ai-foundry-agent-${environmentName}'
  displayName: 'ai-foundry-agent-${environmentName}'
  signInAudience: 'AzureADMyOrg'
  serviceManagementReference: empty(serviceManagementReference) ? null : serviceManagementReference
  spa: {
    redirectUris: [
      'http://localhost:5173'
      'http://localhost:8080'
    ]
  }
  api: {
    oauth2PermissionScopes: [
      {
        adminConsentDescription: 'Allows the app to read and write chat messages'
        adminConsentDisplayName: 'Read and write chat messages'
        id: chatReadWriteScopeId
        isEnabled: true
        type: 'User'
        userConsentDescription: 'Allows the app to read and write your chat messages'
        userConsentDisplayName: 'Read and write your chat messages'
        value: 'Chat.ReadWrite'
      }
    ]
  }
}

resource sp 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: app.appId
}

output clientAppId string = app.appId
output appObjectId string = app.id
