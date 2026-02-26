import { describe, it, expect } from 'vitest';
import { appReducer } from '../appReducer';
import type { AppState, AppAction, IChatItem, IAnnotation } from '../../types/appState';
import type { AccountInfo } from '@azure/msal-browser';

// Initial state factory for clean test isolation
function createInitialState(): AppState {
  return {
    auth: {
      status: 'unauthenticated',
      user: null,
      error: null,
    },
    chat: {
      status: 'idle',
      messages: [],
      currentConversationId: null,
      error: null,
      streamingMessageId: undefined,
    },
    ui: {
      chatInputEnabled: true,
    },
  };
}

// Mock message factory
function createMockMessage(overrides: Partial<IChatItem> = {}): IChatItem {
  return {
    id: 'msg-1',
    role: 'user',
    content: 'Test message',
    more: { time: new Date().toISOString() },
    ...overrides,
  };
}

// Mock AccountInfo factory
function createMockUser(overrides: Partial<AccountInfo> = {}): AccountInfo {
  return {
    homeAccountId: 'home-account-1',
    environment: 'login.microsoftonline.com',
    tenantId: 'tenant-1',
    username: 'test@example.com',
    localAccountId: 'local-1',
    name: 'Test User',
    ...overrides,
  };
}

describe('appReducer', () => {
  describe('AUTH_INITIALIZED', () => {
    it('sets status to authenticated with user', () => {
      const state = createInitialState();
      const user = createMockUser();
      const action: AppAction = { type: 'AUTH_INITIALIZED', user };

      const result = appReducer(state, action);

      expect(result.auth.status).toBe('authenticated');
      expect(result.auth.user).toEqual(user);
      expect(result.auth.error).toBeNull();
    });
  });

  describe('AUTH_TOKEN_EXPIRED', () => {
    it('sets status to unauthenticated', () => {
      const state = createInitialState();
      state.auth.status = 'authenticated';
      const action: AppAction = { type: 'AUTH_TOKEN_EXPIRED' };

      const result = appReducer(state, action);

      expect(result.auth.status).toBe('unauthenticated');
    });
  });

  describe('CHAT_SEND_MESSAGE', () => {
    it('adds message to messages array', () => {
      const state = createInitialState();
      const message = createMockMessage();
      const action: AppAction = { type: 'CHAT_SEND_MESSAGE', message };

      const result = appReducer(state, action);

      expect(result.chat.messages).toHaveLength(1);
      expect(result.chat.messages[0]).toEqual(message);
    });

    it('sets status to sending', () => {
      const state = createInitialState();
      const message = createMockMessage();
      const action: AppAction = { type: 'CHAT_SEND_MESSAGE', message };

      const result = appReducer(state, action);

      expect(result.chat.status).toBe('sending');
    });

    it('preserves existing messages', () => {
      const state = createInitialState();
      const existingMessage = createMockMessage({ id: 'existing-1' });
      state.chat.messages = [existingMessage];

      const newMessage = createMockMessage({ id: 'new-1' });
      const action: AppAction = { type: 'CHAT_SEND_MESSAGE', message: newMessage };

      const result = appReducer(state, action);

      expect(result.chat.messages).toHaveLength(2);
      expect(result.chat.messages[0]).toEqual(existingMessage);
    });
  });

  describe('CHAT_ADD_ASSISTANT_MESSAGE', () => {
    it('adds empty assistant message', () => {
      const state = createInitialState();
      const action: AppAction = { type: 'CHAT_ADD_ASSISTANT_MESSAGE', messageId: 'assistant-1' };

      const result = appReducer(state, action);

      expect(result.chat.messages).toHaveLength(1);
      expect(result.chat.messages[0].role).toBe('assistant');
      expect(result.chat.messages[0].content).toBe('');
      expect(result.chat.messages[0].id).toBe('assistant-1');
    });
  });

  describe('CHAT_START_STREAM', () => {
    it('sets status to streaming', () => {
      const state = createInitialState();
      const action: AppAction = {
        type: 'CHAT_START_STREAM',
        conversationId: 'conv-1',
        messageId: 'msg-1',
      };

      const result = appReducer(state, action);

      expect(result.chat.status).toBe('streaming');
    });

    it('stores conversationId and streamingMessageId', () => {
      const state = createInitialState();
      const action: AppAction = {
        type: 'CHAT_START_STREAM',
        conversationId: 'conv-123',
        messageId: 'msg-456',
      };

      const result = appReducer(state, action);

      expect(result.chat.currentConversationId).toBe('conv-123');
      expect(result.chat.streamingMessageId).toBe('msg-456');
    });

    it('disables chat input', () => {
      const state = createInitialState();
      const action: AppAction = {
        type: 'CHAT_START_STREAM',
        conversationId: 'conv-1',
        messageId: 'msg-1',
      };

      const result = appReducer(state, action);

      expect(result.ui.chatInputEnabled).toBe(false);
    });

    it('clears any existing error', () => {
      const state = createInitialState();
      state.chat.error = { code: 'NETWORK', message: 'Old error', recoverable: true };
      const action: AppAction = {
        type: 'CHAT_START_STREAM',
        conversationId: 'conv-1',
        messageId: 'msg-1',
      };

      const result = appReducer(state, action);

      expect(result.chat.error).toBeNull();
    });
  });

  describe('CHAT_STREAM_CHUNK', () => {
    it('appends content to the streaming message', () => {
      const state = createInitialState();
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant', content: 'Hello' })];

      const action: AppAction = {
        type: 'CHAT_STREAM_CHUNK',
        messageId: 'msg-1',
        content: ' World',
      };

      const result = appReducer(state, action);

      expect(result.chat.messages[0].content).toBe('Hello World');
    });

    it('returns unchanged state if message not found', () => {
      const state = createInitialState();
      state.chat.messages = [createMockMessage({ id: 'msg-1' })];

      const action: AppAction = {
        type: 'CHAT_STREAM_CHUNK',
        messageId: 'non-existent',
        content: ' chunk',
      };

      const result = appReducer(state, action);

      expect(result).toEqual(state);
    });
  });

  describe('CHAT_STREAM_ANNOTATIONS', () => {
    it('adds annotations to the streaming message', () => {
      const state = createInitialState();
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant', content: 'Test' })];

      const annotations: IAnnotation[] = [
        { type: 'uri_citation', label: 'Source', url: 'https://example.com' },
      ];
      const action: AppAction = {
        type: 'CHAT_STREAM_ANNOTATIONS',
        messageId: 'msg-1',
        annotations,
      };

      const result = appReducer(state, action);

      expect(result.chat.messages[0].annotations).toHaveLength(1);
    });

    it('appends to existing annotations', () => {
      const state = createInitialState();
      const existingAnnotation: IAnnotation = { type: 'uri_citation', label: 'Old' };
      state.chat.messages = [
        createMockMessage({ id: 'msg-1', role: 'assistant', annotations: [existingAnnotation] }),
      ];

      const newAnnotations: IAnnotation[] = [{ type: 'file_citation', label: 'New' }];
      const action: AppAction = {
        type: 'CHAT_STREAM_ANNOTATIONS',
        messageId: 'msg-1',
        annotations: newAnnotations,
      };

      const result = appReducer(state, action);

      expect(result.chat.messages[0].annotations).toHaveLength(2);
    });

    it('returns unchanged state if message not found', () => {
      const state = createInitialState();
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant' })];

      const annotations: IAnnotation[] = [{ type: 'uri_citation', label: 'Source' }];
      const action: AppAction = {
        type: 'CHAT_STREAM_ANNOTATIONS',
        messageId: 'non-existent',
        annotations,
      };

      const result = appReducer(state, action);

      expect(result).toEqual(state);
    });
  });

  describe('CHAT_MCP_APPROVAL_REQUEST', () => {
    it('adds approval message with mcpApproval data', () => {
      const state = createInitialState();
      const approvalRequest = {
        id: 'approval-123',
        toolName: 'read_file',
        serverLabel: 'File System',
        arguments: '{"path": "/test"}',
      };
      const action: AppAction = {
        type: 'CHAT_MCP_APPROVAL_REQUEST',
        messageId: 'msg-1',
        approvalRequest,
        previousResponseId: 'prev-response-1',
      };

      const result = appReducer(state, action);

      expect(result.chat.messages).toHaveLength(1);
      expect(result.chat.messages[0].role).toBe('approval');
      expect(result.chat.messages[0].mcpApproval).toBeDefined();
      expect(result.chat.messages[0].mcpApproval?.toolName).toBe('read_file');
      expect(result.chat.messages[0].mcpApproval?.serverLabel).toBe('File System');
    });

    it('sets status to idle', () => {
      const state = createInitialState();
      state.chat.status = 'streaming';
      const approvalRequest = {
        id: 'approval-123',
        toolName: 'test_tool',
        serverLabel: 'Test',
      };

      const result = appReducer(state, {
        type: 'CHAT_MCP_APPROVAL_REQUEST',
        messageId: 'msg-1',
        approvalRequest,
        previousResponseId: null,
      });

      expect(result.chat.status).toBe('idle');
    });

    it('disables chat input until approval', () => {
      const state = createInitialState();
      state.ui.chatInputEnabled = true;
      const approvalRequest = {
        id: 'approval-123',
        toolName: 'test_tool',
        serverLabel: 'Test',
      };

      const result = appReducer(state, {
        type: 'CHAT_MCP_APPROVAL_REQUEST',
        messageId: 'msg-1',
        approvalRequest,
        previousResponseId: null,
      });

      expect(result.ui.chatInputEnabled).toBe(false);
    });

    it('handles null previousResponseId', () => {
      const state = createInitialState();
      const approvalRequest = {
        id: 'approval-123',
        toolName: 'test_tool',
        serverLabel: 'Test',
      };

      const result = appReducer(state, {
        type: 'CHAT_MCP_APPROVAL_REQUEST',
        messageId: 'msg-1',
        approvalRequest,
        previousResponseId: null,
      });

      expect(result.chat.messages[0].mcpApproval?.previousResponseId).toBe('');
    });
  });

  describe('CHAT_STREAM_COMPLETE', () => {
    it('sets status to idle', () => {
      const state = createInitialState();
      state.chat.status = 'streaming';
      state.chat.streamingMessageId = 'msg-1';
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant' })];

      const action: AppAction = {
        type: 'CHAT_STREAM_COMPLETE',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, duration: 1234 },
      };

      const result = appReducer(state, action);

      expect(result.chat.status).toBe('idle');
    });

    it('clears streamingMessageId', () => {
      const state = createInitialState();
      state.chat.streamingMessageId = 'msg-1';
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant' })];

      const action: AppAction = {
        type: 'CHAT_STREAM_COMPLETE',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, duration: 1234 },
      };

      const result = appReducer(state, action);

      expect(result.chat.streamingMessageId).toBeUndefined();
    });

    it('enables chat input', () => {
      const state = createInitialState();
      state.ui.chatInputEnabled = false;
      state.chat.streamingMessageId = 'msg-1';
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant' })];

      const action: AppAction = {
        type: 'CHAT_STREAM_COMPLETE',
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150, duration: 1234 },
      };

      const result = appReducer(state, action);

      expect(result.ui.chatInputEnabled).toBe(true);
    });

    it('adds usage info and duration to the message', () => {
      const state = createInitialState();
      state.chat.streamingMessageId = 'msg-1';
      state.chat.messages = [createMockMessage({ id: 'msg-1', role: 'assistant' })];

      const usage = { promptTokens: 100, completionTokens: 50, totalTokens: 150, duration: 1234 };
      const action: AppAction = { type: 'CHAT_STREAM_COMPLETE', usage };

      const result = appReducer(state, action);

      expect(result.chat.messages[0].more?.usage).toEqual(usage);
      expect(result.chat.messages[0].duration).toBe(1234);
    });
  });

  describe('CHAT_CANCEL_STREAM', () => {
    it('sets status to idle', () => {
      const state = createInitialState();
      state.chat.status = 'streaming';

      const result = appReducer(state, { type: 'CHAT_CANCEL_STREAM' });

      expect(result.chat.status).toBe('idle');
    });

    it('clears streamingMessageId', () => {
      const state = createInitialState();
      state.chat.streamingMessageId = 'msg-1';

      const result = appReducer(state, { type: 'CHAT_CANCEL_STREAM' });

      expect(result.chat.streamingMessageId).toBeUndefined();
    });

    it('enables chat input', () => {
      const state = createInitialState();
      state.ui.chatInputEnabled = false;

      const result = appReducer(state, { type: 'CHAT_CANCEL_STREAM' });

      expect(result.ui.chatInputEnabled).toBe(true);
    });
  });

  describe('CHAT_ERROR', () => {
    it('sets status to error with error details', () => {
      const state = createInitialState();
      const error = { code: 'NETWORK' as const, message: 'Connection failed', recoverable: true };

      const result = appReducer(state, { type: 'CHAT_ERROR', error });

      expect(result.chat.status).toBe('error');
      expect(result.chat.error).toEqual(error);
    });

    it('enables input for recoverable errors', () => {
      const state = createInitialState();
      state.ui.chatInputEnabled = false;
      const error = { code: 'NETWORK' as const, message: 'Timeout', recoverable: true };

      const result = appReducer(state, { type: 'CHAT_ERROR', error });

      expect(result.ui.chatInputEnabled).toBe(true);
    });

    it('disables input for non-recoverable errors', () => {
      const state = createInitialState();
      const error = { code: 'AUTH' as const, message: 'Session expired', recoverable: false };

      const result = appReducer(state, { type: 'CHAT_ERROR', error });

      expect(result.ui.chatInputEnabled).toBe(false);
    });

    it('clears streamingMessageId', () => {
      const state = createInitialState();
      state.chat.streamingMessageId = 'msg-1';
      const error = { code: 'NETWORK' as const, message: 'Error', recoverable: true };

      const result = appReducer(state, { type: 'CHAT_ERROR', error });

      expect(result.chat.streamingMessageId).toBeUndefined();
    });
  });

  describe('CHAT_CLEAR_ERROR', () => {
    it('clears error and sets status to idle', () => {
      const state = createInitialState();
      state.chat.status = 'error';
      state.chat.error = { code: 'NETWORK', message: 'Old error', recoverable: true };

      const result = appReducer(state, { type: 'CHAT_CLEAR_ERROR' });

      expect(result.chat.error).toBeNull();
      expect(result.chat.status).toBe('idle');
    });

    it('enables chat input', () => {
      const state = createInitialState();
      state.ui.chatInputEnabled = false;

      const result = appReducer(state, { type: 'CHAT_CLEAR_ERROR' });

      expect(result.ui.chatInputEnabled).toBe(true);
    });
  });

  describe('CHAT_CLEAR', () => {
    it('clears all messages', () => {
      const state = createInitialState();
      state.chat.messages = [createMockMessage(), createMockMessage({ id: 'msg-2' })];

      const result = appReducer(state, { type: 'CHAT_CLEAR' });

      expect(result.chat.messages).toHaveLength(0);
    });

    it('resets conversationId to null', () => {
      const state = createInitialState();
      state.chat.currentConversationId = 'conv-123';

      const result = appReducer(state, { type: 'CHAT_CLEAR' });

      expect(result.chat.currentConversationId).toBeNull();
    });

    it('sets status to idle', () => {
      const state = createInitialState();
      state.chat.status = 'streaming';

      const result = appReducer(state, { type: 'CHAT_CLEAR' });

      expect(result.chat.status).toBe('idle');
    });

    it('enables chat input', () => {
      const state = createInitialState();
      state.ui.chatInputEnabled = false;

      const result = appReducer(state, { type: 'CHAT_CLEAR' });

      expect(result.ui.chatInputEnabled).toBe(true);
    });

    it('clears any existing error', () => {
      const state = createInitialState();
      state.chat.error = { code: 'NETWORK', message: 'Error', recoverable: true };

      const result = appReducer(state, { type: 'CHAT_CLEAR' });

      expect(result.chat.error).toBeNull();
    });
  });

  describe('immutability', () => {
    it('does not mutate original state', () => {
      const state = createInitialState();
      const originalState = JSON.parse(JSON.stringify(state));
      const message = createMockMessage();

      appReducer(state, { type: 'CHAT_SEND_MESSAGE', message });

      expect(state).toEqual(originalState);
    });
  });
});
