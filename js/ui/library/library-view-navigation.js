import {
  DETAIL_VIEW_BY_TYPE,
  PAGED_SEARCH_ENTITY_TYPES,
  createFolderNavigationKey,
  isMobileLayout,
  normalizeFolderDetail
} from './library-view-shared.js';

export const navigationMethods = {
  getNavigationSnapshot() {
    const queryFingerprint = JSON.stringify(this.getPagedQuery());
    if (this.pagedState?.phase === 'committed' && this.pagedQueryKey === queryFingerprint) {
      this.pagedContentScrollTop = Number(this.content?.scrollTop) || 0;
      this.capturePagedAnchor();
    }
    const anchor = this.pagedAnchor?.queryFingerprint === queryFingerprint
      ? { ...this.pagedAnchor }
      : null;
    const liveContentScrollTop = Number(this.content?.scrollTop);
    return {
      currentView: this.currentView,
      detail: this.detail ? { ...this.detail } : null,
      searchQuery: this.searchQuery,
      searchEntityType: this.searchEntityType,
      searchEntityReturnView: this.searchEntityReturnView,
      pagedPosition: {
        queryFingerprint,
        anchor,
        viewportOrdinal: this.pagedViewportOrdinal,
        viewportOffsetPx: this.pagedViewportOffsetPx,
        contentScrollTop: Number.isFinite(liveContentScrollTop)
          ? liveContentScrollTop
          : (this.pagedContentScrollTop || 0)
      }
    };
  },

  applyNavigationSnapshot(snapshot = {}, { folderBrowseState = null } = {}) {
    this.invalidateNavigationIntent();
    this.currentView = snapshot.currentView || 'tracks';
    this.detail = normalizeFolderDetail(snapshot.detail);
    if (this.detail?.type === 'folderNode') {
      this.restoreFolderBrowseSnapshot(
        folderBrowseState,
        createFolderNavigationKey(this.detail.folderId, this.detail.path)
      );
    }
    this.detailSortOverride = false;
    this.searchQuery = snapshot.searchQuery || '';
    this.searchEntityType = PAGED_SEARCH_ENTITY_TYPES.includes(snapshot.searchEntityType)
      ? snapshot.searchEntityType
      : null;
    this.searchEntityReturnView = snapshot.searchEntityReturnView || null;
    this.searchEntityReturnSnapshot = null;
    this.pendingPagedNavigationPosition = snapshot.pagedPosition || null;
    if (this.searchInput) this.searchInput.value = this.searchQuery;
    this.clearSelection({ keepMobileSelectionMode: false });
    this.render();
  },

  pushMobileHistory(previousSnapshot = null) {
    if (!isMobileLayout() || typeof globalThis.history?.pushState !== 'function') return;
    if (!this.mobileHistoryInitialized) {
      const currentState = globalThis.history.state;
      if (currentState?.effetuneLibrary && Number.isSafeInteger(currentState.index)) {
        this.mobileHistoryIndex = Math.max(0, currentState.index);
        this.mobileHistoryDepth = Number.isSafeInteger(currentState.depth)
          ? Math.max(0, currentState.depth)
          : Math.max(0, currentState.index);
      } else {
        this.mobileHistoryIndex = 0;
        this.mobileHistoryDepth = 0;
      }
      this.mobileHistoryInitialized = true;
    }
    if (typeof globalThis.history.replaceState === 'function') {
      const currentState = globalThis.history.state;
      globalThis.history.replaceState({
        ...(currentState || {}),
        effetuneLibrary: true,
        index: this.mobileHistoryIndex,
        depth: this.mobileHistoryDepth,
        snapshot: previousSnapshot || currentState?.snapshot || this.getNavigationSnapshot()
      }, '');
    }
    const currentIndex = Number.isSafeInteger(this.mobileHistoryIndex) ? this.mobileHistoryIndex : 0;
    const currentDepth = Number.isSafeInteger(this.mobileHistoryDepth) ? this.mobileHistoryDepth : 0;
    this.mobileHistoryIndex = currentIndex + 1;
    this.mobileHistoryDepth = currentDepth + 1;
    globalThis.history.pushState({
      effetuneLibrary: true,
      index: this.mobileHistoryIndex,
      depth: this.mobileHistoryDepth,
      snapshot: this.getNavigationSnapshot()
    }, '');
  },

  navigateToView(view, { pushHistory = true } = {}) {
    this.invalidateNavigationIntent();
    const previousSnapshot = this.getNavigationSnapshot();
    this.currentView = view || 'tracks';
    this.detail = null;
    this.detailSortOverride = false;
    this.searchQuery = '';
    this.searchEntityType = null;
    this.searchEntityReturnView = null;
    this.searchEntityReturnSnapshot = null;
    this.navigationReturnSnapshot = null;
    this.clearSelection({ keepMobileSelectionMode: false });
    if (this.searchInput) this.searchInput.value = '';
    if (pushHistory) this.pushMobileHistory(previousSnapshot);
    this.render();
  },

  navigateToDetail(detail, view = null, { pushHistory = true, folderBrowseState = null } = {}) {
    if (!detail) {
      this.navigateToView(view || this.currentView, { pushHistory });
      return;
    }
    this.invalidateNavigationIntent();
    const previousSnapshot = this.getNavigationSnapshot();
    const normalizedDetail = normalizeFolderDetail(detail);
    const staysInFolderHierarchy = this.detail?.type === 'folderNode' &&
      normalizedDetail.type === 'folderNode' && this.detail.folderId === normalizedDetail.folderId;
    if (!staysInFolderHierarchy) {
      this.navigationReturnSnapshot = previousSnapshot;
    }
    this.currentView = view || (normalizedDetail.type === 'folderNode'
      ? 'folders'
      : DETAIL_VIEW_BY_TYPE[normalizedDetail.type]) || this.currentView;
    this.detail = normalizedDetail;
    if (normalizedDetail.type === 'folderNode') {
      this.restoreFolderBrowseSnapshot(
        folderBrowseState,
        createFolderNavigationKey(normalizedDetail.folderId, normalizedDetail.path)
      );
    }
    this.detailSortOverride = false;
    this.searchQuery = '';
    this.searchEntityType = null;
    this.searchEntityReturnView = null;
    this.searchEntityReturnSnapshot = null;
    this.clearSelection({ keepMobileSelectionMode: false });
    if (this.searchInput) this.searchInput.value = '';
    if (pushHistory) this.pushMobileHistory(previousSnapshot);
    this.render();
  },

  navigateToSearchEntityResults(entityType, { pushHistory = true } = {}) {
    if (!PAGED_SEARCH_ENTITY_TYPES.includes(entityType) || !this.searchQuery.trim()) return false;
    this.invalidateNavigationIntent();
    const previousSnapshot = this.getNavigationSnapshot();
    this.searchEntityReturnSnapshot = previousSnapshot;
    this.searchEntityReturnView = this.currentView;
    this.currentView = DETAIL_VIEW_BY_TYPE[entityType];
    this.detail = null;
    this.detailSortOverride = false;
    this.searchEntityType = entityType;
    this.clearSelection({ keepMobileSelectionMode: false });
    if (this.searchInput) this.searchInput.value = this.searchQuery;
    if (pushHistory) this.pushMobileHistory(previousSnapshot);
    this.render();
    return true;
  },

  navigateBack({ fromPopState = false } = {}) {
    if (this.detail?.type === 'folderNode' && (this.searchQuery || this.searchInput?.value)) {
      this.invalidateNavigationIntent();
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
      this.searchQuery = '';
      this.searchEntityType = null;
      this.searchEntityReturnView = null;
      if (this.searchInput) this.searchInput.value = '';
      this.render();
      return true;
    }
    if (isMobileLayout() && !fromPopState && this.mobileHistoryDepth > 0 && typeof globalThis.history?.back === 'function') {
      globalThis.history.back();
      return true;
    }
    if (this.searchEntityType) {
      this.invalidateNavigationIntent();
      const returnSnapshot = this.searchEntityReturnSnapshot;
      this.currentView = returnSnapshot?.currentView || this.searchEntityReturnView || 'tracks';
      this.searchEntityType = null;
      this.searchEntityReturnView = null;
      this.searchEntityReturnSnapshot = null;
      this.pendingPagedNavigationPosition = returnSnapshot?.pagedPosition || null;
      this.detail = normalizeFolderDetail(returnSnapshot?.detail);
      this.clearSelection({ keepMobileSelectionMode: false });
      if (this.searchInput) this.searchInput.value = this.searchQuery;
      this.render();
      return true;
    }
    if (this.detail?.type === 'folderNode' && this.detail.path !== '') {
      const childPath = this.detail.path;
      const separator = childPath.lastIndexOf('/');
      const parentPath = separator < 0 ? '' : childPath.slice(0, separator);
      this.navigateToFolderPath(parentPath, { pushHistory: false });
      return true;
    }
    if (!this.detail && !this.searchQuery) return false;
    this.invalidateNavigationIntent();
    const returnSnapshot = this.navigationReturnSnapshot;
    this.pendingFolderFocusPath = null;
    this.pendingFolderFocusFolderId = null;
    this.detail = null;
    this.searchQuery = '';
    this.searchEntityType = null;
    this.searchEntityReturnView = null;
    this.searchEntityReturnSnapshot = null;
    this.navigationReturnSnapshot = null;
    this.pendingPagedNavigationPosition = returnSnapshot?.pagedPosition || null;
    this.clearSelection({ keepMobileSelectionMode: false });
    if (this.searchInput) this.searchInput.value = '';
    this.render();
    return true;
  },

  handleMobilePopState(event) {
    if (this.suppressPopStateCount > 0) {
      this.suppressPopStateCount -= 1;
      return;
    }
    if (!isMobileLayout() || !document.body?.classList.contains('view-library')) return;
    const state = event.state?.effetuneLibrary ? event.state : null;
    const snapshot = state?.snapshot ?? null;
    if (!snapshot) return;
    const currentDetail = this.detail?.type === 'folderNode' ? { ...this.detail } : null;
    const clearCurrentFolderSearch = Boolean(currentDetail && (this.searchQuery || this.searchInput?.value));
    if (Number.isSafeInteger(state.index)) {
      this.mobileHistoryIndex = Math.max(0, state.index);
      this.mobileHistoryDepth = Number.isSafeInteger(state.depth)
        ? Math.max(0, state.depth)
        : this.mobileHistoryIndex;
    } else {
      this.mobileHistoryIndex = Math.max(0, (Number(this.mobileHistoryIndex) || 0) - 1);
      this.mobileHistoryDepth = Math.max(0, (Number(this.mobileHistoryDepth) || 0) - 1);
      globalThis.history?.replaceState?.({
        ...state,
        effetuneLibrary: true,
        index: this.mobileHistoryIndex,
        depth: this.mobileHistoryDepth,
        snapshot
      }, '');
    }
    if (clearCurrentFolderSearch) {
      this.invalidateNavigationIntent();
      clearTimeout(this.searchDebounceTimer);
      this.searchDebounceTimer = null;
      this.searchQuery = '';
      this.searchEntityType = null;
      this.searchEntityReturnView = null;
      if (this.searchInput) this.searchInput.value = '';
      this.render();
      this.mobileHistoryIndex += 1;
      this.mobileHistoryDepth += 1;
      globalThis.history?.pushState?.({
        effetuneLibrary: true,
        index: this.mobileHistoryIndex,
        depth: this.mobileHistoryDepth,
        snapshot: this.getNavigationSnapshot()
      }, '');
      return;
    }
    const targetDetail = normalizeFolderDetail(snapshot.detail);
    this.saveCurrentFolderNavigationPosition();
    const targetKey = targetDetail?.type === 'folderNode'
      ? createFolderNavigationKey(targetDetail.folderId, targetDetail.path)
      : null;
    const targetFolderBrowseState = targetKey
      ? this.folderNavigationPositions.get(targetKey)?.folderBrowseState ?? null
      : null;
    this.pendingFolderFocusPath = null;
    this.pendingFolderFocusFolderId = null;
    if (currentDetail && targetDetail?.type === 'folderNode' &&
        currentDetail.folderId === targetDetail.folderId) {
      const targetPath = targetDetail.path;
      const isAncestor = targetPath === '' || currentDetail.path.startsWith(`${targetPath}/`);
      if (isAncestor) {
        const remainder = targetPath === ''
          ? currentDetail.path
          : currentDetail.path.slice(targetPath.length + 1);
        const childName = remainder.split('/')[0];
        if (childName) {
          this.pendingFolderFocusPath = targetPath === '' ? childName : `${targetPath}/${childName}`;
          this.pendingFolderFocusFolderId = targetDetail.folderId;
        }
      }
    }
    this.applyNavigationSnapshot(snapshot, { folderBrowseState: targetFolderBrowseState });
  }
};
