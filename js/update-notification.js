function translate(windowRef, key, fallback, params = {}) {
    const translated = windowRef.uiManager?.t?.(key, params);
    return translated && translated !== key ? translated : fallback;
}

export function createUpdateNotification(updateInfo, {
    documentRef = document,
    windowRef = window
} = {}) {
    const container = documentRef.createElement('div');
    container.className = 'update-notification';
    container.setAttribute?.('role', 'status');

    const releaseButton = documentRef.createElement('button');
    releaseButton.type = 'button';
    releaseButton.className = 'update-release-link';
    releaseButton.textContent = translate(
        windowRef,
        'ui.newVersionAvailable',
        `New ${updateInfo.version} available.`,
        { version: updateInfo.version }
    );
    releaseButton.addEventListener('click', () => {
        if (windowRef.electronAPI?.openExternal) windowRef.electronAPI.openExternal(updateInfo.url);
        else windowRef.open(updateInfo.url, '_blank', 'noopener');
    });
    container.appendChild(releaseButton);

    const downloadUpdate = windowRef.electronAPI?.downloadUpdate;
    if (updateInfo.autoUpdateSupported !== true || typeof downloadUpdate !== 'function') {
        return container;
    }

    const idleLabel = translate(windowRef, 'ui.downloadUpdate', 'Download update');
    const downloadingLabel = translate(windowRef, 'ui.downloadingUpdate', 'Downloading...');
    const restartHint = translate(
        windowRef,
        'ui.downloadUpdateTitle',
        'EffeTune will restart when the update is complete.'
    );
    const downloadButton = documentRef.createElement('button');
    downloadButton.type = 'button';
    downloadButton.className = 'update-download-button';
    downloadButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="10"/><path d="M12 6.5v8m0 0-3-3m3 3 3-3M8 17h8"/></svg>';
    downloadButton.title = `${idleLabel}\n${restartHint}`;
    downloadButton.setAttribute('aria-label', idleLabel);
    downloadButton.setAttribute('aria-description', restartHint);
    downloadButton.addEventListener('click', async () => {
        if (downloadButton.disabled) return;

        downloadButton.disabled = true;
        downloadButton.title = downloadingLabel;
        downloadButton.setAttribute('aria-label', downloadingLabel);

        try {
            const result = await downloadUpdate();
            if (result?.success === true) return;
        } catch (error) {
            console.error('Failed to download update:', error);
        }

        downloadButton.disabled = false;
        downloadButton.title = `${idleLabel}\n${restartHint}`;
        downloadButton.setAttribute('aria-label', idleLabel);
        windowRef.uiManager?.setError?.('ui.updateDownloadFailed', true);
    });
    container.appendChild(downloadButton);
    return container;
}
