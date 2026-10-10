// Neutered Google Publisher Tag: full API surface, no ads.
(function () {
  'use strict';
  const noop = function () {};
  const self = function () {
    return this;
  };
  const nul = () => null;
  const arr = () => [];
  const str = () => '';
  const Slot = function () {};
  for (const m of ['addService', 'clearCategoryExclusions', 'clearTargeting', 'defineSizeMapping', 'set', 'setCategoryExclusion',
    'setClickUrl', 'setCollapseEmptyDiv', 'setConfig', 'setTargeting', 'updateTargetingFromMap']) Slot.prototype[m] = self;
  for (const m of ['getAdUnitPath', 'getAttributeKeys', 'getCategoryExclusions', 'getTargeting', 'getTargetingKeys']) Slot.prototype[m] = arr;
  Slot.prototype.get = nul;
  Slot.prototype.getResponseInformation = nul;
  Slot.prototype.getDomId = str;
  Slot.prototype.getSlotElementId = str;
  Slot.prototype.getSlotId = self;
  const pubads = {};
  for (const m of ['addEventListener', 'clearCategoryExclusions', 'clearTagForChildDirectedTreatment', 'clearTargeting', 'set',
    'setCategoryExclusion', 'setCookieOptions', 'setForceSafeFrame', 'setLocation', 'setPublisherProvidedId', 'setPrivacySettings',
    'setRequestNonPersonalizedAds', 'setSafeFrameConfig', 'setTagForChildDirectedTreatment', 'setTargeting', 'setVideoContent']) pubads[m] = self;
  for (const m of ['clear', 'collapseEmptyDivs', 'disableInitialLoad', 'display', 'enableAsyncRendering', 'enableLazyLoad',
    'enableSingleRequest', 'enableSyncRendering', 'enableVideoAds', 'refresh', 'removeEventListener', 'setCentering', 'updateCorrelator']) pubads[m] = noop;
  for (const m of ['getAttributeKeys', 'getTargeting', 'getTargetingKeys', 'getSlots']) pubads[m] = arr;
  pubads.get = nul;
  pubads.definePassback = () => new Slot();
  pubads.defineOutOfPagePassback = () => new Slot();
  const gt = window.googletag || {};
  const pending = Array.isArray(gt.cmd) ? gt.cmd.slice() : [];
  gt.apiReady = true;
  gt.pubadsReady = true;
  gt.cmd = [];
  gt.cmd.push = function (fn) {
    try {
      if (typeof fn === 'function') fn();
    } catch (e) {
      /* ignore */
    }
    return 1;
  };
  gt.pubads = () => pubads;
  gt.companionAds = () => ({ addEventListener: self, enableSyncLoading: noop, setRefreshUnfilledSlots: noop });
  gt.content = () => ({ addEventListener: self, setContent: noop });
  gt.defineSlot = () => new Slot();
  gt.defineOutOfPageSlot = () => new Slot();
  gt.destroySlots = noop;
  gt.disablePublisherConsole = noop;
  gt.display = noop;
  gt.enableServices = noop;
  gt.getVersion = str;
  gt.setAdIframeTitle = noop;
  gt.setConfig = noop;
  gt.sizeMapping = () => ({ addSize: self, build: nul });
  window.googletag = gt;
  for (const fn of pending) gt.cmd.push(fn);
})();
