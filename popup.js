document.getElementById('toggle').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      if (typeof window.__chessAnalyzerToggle === 'function') {
        window.__chessAnalyzerToggle();
      }
    }
  });
  window.close();
});
