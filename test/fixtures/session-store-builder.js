// test/fixtures/session-store-builder.js
// Builds a minimal in-memory opencode session store for use in tests.
// Only the columns that the source code actually queries are defined.

import { DatabaseSync } from 'node:sqlite';

/**
 * Build a minimal in-memory session store matching the opencode schema.
 * Returns a helper object with convenience methods for inserting test rows.
 */
export function buildSessionStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      agent TEXT,
      time_created INTEGER
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY,
      message_id TEXT,
      session_id TEXT,
      time_created INTEGER,
      data TEXT
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      data TEXT
    );
  `);

  let partSeq = 0;

  return {
    db,

    /**
     * Insert a session row.
     * @param {string} id
     * @param {string} agent
     * @param {number} [timeCreated]
     */
    addSession(id, agent, timeCreated = Date.now()) {
      db.prepare('INSERT INTO session (id, agent, time_created) VALUES (?, ?, ?)').run(
        id,
        agent,
        timeCreated,
      );
    },

    /**
     * Insert a raw part row with pre-built JSON data.
     * @param {string} sessionId
     * @param {object} data        - will be JSON.stringify'd into the data column
     * @param {number} [timeCreated]
     * @returns {string}           the generated part id
     */
    addPart(sessionId, data, timeCreated = Date.now()) {
      const id = `part-${++partSeq}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        'INSERT INTO part (id, session_id, time_created, data) VALUES (?, ?, ?, ?)',
      ).run(id, sessionId, timeCreated, JSON.stringify(data));
      return id;
    },

    /**
     * Insert a tool-error part.
     * @param {string} sessionId
     * @param {string} tool
     * @param {string} errorText
     * @param {number} [timeCreated]
     */
    addToolError(sessionId, tool, errorText, timeCreated = Date.now()) {
      return this.addPart(
        sessionId,
        {
          type: 'tool',
          tool,
          state: { status: 'error', error: errorText },
        },
        timeCreated,
      );
    },

    /**
     * Insert a permission-reject part.
     * A permission reject has error containing 'rejected permission' and the
     * command in state.input.command.
     * @param {string} sessionId
     * @param {string} tool
     * @param {string} command
     * @param {number} [timeCreated]
     */
    addPermissionReject(sessionId, tool, command, timeCreated = Date.now()) {
      return this.addPart(
        sessionId,
        {
          type: 'tool',
          tool,
          state: {
            status: 'error',
            error: 'rejected permission for tool',
            input: { command },
          },
        },
        timeCreated,
      );
    },

    /**
     * Insert a completed bash command part.
     * @param {string} sessionId
     * @param {string} command
     * @param {number} [timeCreated]
     */
    addBashCommand(sessionId, command, timeCreated = Date.now()) {
      return this.addPart(
        sessionId,
        {
          type: 'tool',
          tool: 'bash',
          state: { status: 'completed', input: { command } },
        },
        timeCreated,
      );
    },

    /**
     * Insert a webfetch tool part (completed).
     * Used to simulate a real webfetch call in the time window,
     * which prevents suspect-fabrication detection.
     * @param {string} sessionId
     * @param {string} url
     * @param {number} [timeCreated]
     * @returns {string}  the generated part id
     */
    addWebfetchCall(sessionId, url, timeCreated = Date.now()) {
      return this.addPart(
        sessionId,
        {
          type: 'tool',
          tool: 'webfetch',
          state: { status: 'completed', input: { url } },
        },
        timeCreated,
      );
    },

    /**
     * Insert an assistant text part (with a message row for role='assistant').
     * The detection query joins part.message_id → message.data->>'$.role'
     * to isolate the agent's own answer text.
     * @param {string} sessionId
     * @param {string} text         - the assistant's answer text
     * @param {number} [timeCreated]
     * @returns {string}            the generated part id
     */
    addAssistantTextPart(sessionId, text, timeCreated = Date.now()) {
      // Create the parent message with role='assistant'.
      const messageId = `msg-${++partSeq}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        'INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)',
      ).run(messageId, sessionId, JSON.stringify({ role: 'assistant' }));

      // Create the text part linked to that message.
      const partId = `part-${++partSeq}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      ).run(partId, messageId, sessionId, timeCreated, JSON.stringify({ type: 'text', text }));
      return partId;
    },

    /**
     * Insert a user text part (with a message row for role='user').
     * Used to verify that user-prompt URLs are NOT matched by the
     * suspect-fabrication query (which filters on role='assistant').
     * @param {string} sessionId
     * @param {string} text         - the user's message text
     * @param {number} [timeCreated]
     * @returns {string}            the generated part id
     */
    addUserTextPart(sessionId, text, timeCreated = Date.now()) {
      const messageId = `msg-${++partSeq}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        'INSERT INTO message (id, session_id, data) VALUES (?, ?, ?)',
      ).run(messageId, sessionId, JSON.stringify({ role: 'user' }));

      const partId = `part-${++partSeq}-${Math.random().toString(36).slice(2)}`;
      db.prepare(
        'INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)',
      ).run(partId, messageId, sessionId, timeCreated, JSON.stringify({ type: 'text', text }));
      return partId;
    },
  };
}
