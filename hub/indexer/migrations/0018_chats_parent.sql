-- Sub-sessions: a chat may branch off a parent chat. The sidebar nests
-- children under their parent, and a child's first turn is seeded with a
-- digest of the parent conversation. Deleting a parent promotes its children
-- to top level rather than dropping them.

ALTER TABLE chats ADD COLUMN parent_chat_id UUID REFERENCES chats(chat_id) ON DELETE SET NULL;

CREATE INDEX chats_parent_chat_id_idx
  ON chats (parent_chat_id) WHERE parent_chat_id IS NOT NULL;
