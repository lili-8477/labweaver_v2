-- How a chat runs its turns: 'chat' (plain agent) or 'auto' (the self-driving
-- tick harness). Per chat, chosen from the composer's mode menu; replaces the
-- workspace-wide ~/.claude/.harness_active toggle, which leaked across chats.

ALTER TABLE chats ADD COLUMN mode TEXT NOT NULL DEFAULT 'chat';
