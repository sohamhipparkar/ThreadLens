// background.js — opens the side panel and adds a right-click entry for selected text.

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  chrome.contextMenus.create({
    id: 'threadlens-selection',
    title: 'Analyse selected email text with ThreadLens',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'threadlens-selection' || !tab) return;
  // open first (must happen inside the user gesture), then hand over the text
  chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  await chrome.storage.session.set({ pendingText: { text: info.selectionText || '', at: Date.now() } });
});
