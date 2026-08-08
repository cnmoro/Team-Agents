import { useState, type ReactNode } from 'react';
import { useChat } from '../state/ChatContext.js';
import { Sidebar } from './Sidebar.js';
import { ConversationView } from './ConversationView.js';
import { NotificationHost } from './NotificationHost.js';
import { SettingsDialog } from './SettingsDialog.js';
import { NewChatDialog } from './NewChatDialog.js';

export function Shell(): ReactNode {
  const { activeConversationId } = useChat();
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [newChatMode, setNewChatMode] = useState<'dm' | 'group' | null>(null);

  return (
    <>
      {/* On narrow viewports one pane is shown at a time; `data-pane` drives it. */}
      <div className="ta-shell" data-pane={activeConversationId ? 'conversation' : 'sidebar'}>
        <Sidebar
          onOpenSettings={() => setIsSettingsOpen(true)}
          onNewChat={(mode) => setNewChatMode(mode)}
        />
        <ConversationView />
      </div>

      <NotificationHost />

      <SettingsDialog isOpen={isSettingsOpen} onOpenChange={setIsSettingsOpen} />
      <NewChatDialog
        mode={newChatMode}
        onClose={() => setNewChatMode(null)}
      />
    </>
  );
}
