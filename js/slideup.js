(function () {
    if (window.__qualtricsSlideupInitDone) {
        return;
    }
    window.__qualtricsSlideupInitDone = true;

    var displayAfterUserScrollsPastPercentOfPage = 20;
    var displayAfterThisManySeconds = 0;
    var scrollThrottleMs = 120;

    var autoTriggerConsumed = false;
    var isAutoOpening = false;
    var isSurveyOpen = false;
    var displayTimerId = null;
    var scrollHandlerAdded = false;
    var lastProcessedScrollEventTime = 0;
    var lastFocusBeforeSurveyOpen = null;
    var lastUserContextElement = null;
    var liveRegion = null;
    var openAnnouncementSent = false;
    var openingAnnouncementSent = false;

    createLiveRegion();
    watchForManualOpenAndStateChanges();

    if (displayAfterThisManySeconds > 0) {
        addTimer();
    }

    if (displayAfterUserScrollsPastPercentOfPage > 0) {
        addScrollHandler();
    }

    function createLiveRegion() {
        if (liveRegion) return liveRegion;

        liveRegion = document.createElement('div');
        liveRegion.setAttribute('role', 'status');
        liveRegion.setAttribute('aria-live', 'polite');
        liveRegion.setAttribute('aria-atomic', 'true');
        liveRegion.style.cssText =
            'position:absolute;width:1px;height:1px;overflow:hidden;' +
            'clip:rect(0,0,0,0);white-space:nowrap;border:0;';

        document.body.appendChild(liveRegion);
        return liveRegion;
    }

    function announce(message) {
        var region = createLiveRegion();
        region.textContent = '';
        setTimeout(function () {
            region.textContent = message;
        }, 50);
    }

    function announceOpeningIfNeeded() {
        if (openingAnnouncementSent || openAnnouncementSent) return;
        announce('Opening feedback survey.');
        openingAnnouncementSent = true;
    }

    function resetAnnouncements() {
        openAnnouncementSent = false;
        openingAnnouncementSent = false;
    }

    function getLauncherButton() {
        return (
            document.getElementById('QSIFeedbackButton-btn') ||
            document.querySelector('.QSIFeedbackButton button')
        );
    }

    function getSurveyFrame() {
        return (
            document.getElementById('QSIFeedbackButton-survey-iframe') ||
            document.querySelector('.QSIFeedbackButton iframe') ||
            document.querySelector('#ZN_eaDVkKUnDpnwcei iframe')
        );
    }

    function isElementVisible(element) {
        if (!element || !window.getComputedStyle) return false;

        var style = window.getComputedStyle(element);
        if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.opacity === '0'
        ) {
            return false;
        }

        var rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function isElementA11yVisible(element) {
        return !!element && !element.closest('[aria-hidden="true"], [hidden], [inert]');
    }

    function isSurveyCurrentlyOpen() {
        var frame = getSurveyFrame();

        /* The Qualtrics container can exist while collapsed/hidden, which causes
             false positives. Treat the survey as open only when its iframe is both
             visible and not inside hidden/aria-hidden/inert ancestors. */
        if (frame && isElementVisible(frame) && isElementA11yVisible(frame)) {
            return true;
        }

        return false;
    }

    function isValidRestoreTarget(element) {
        if (!element || !document.contains(element)) return false;
        if (element === document.body || element === document.documentElement) return false;
        if (element.closest('#QSIFeedbackButton-target-container, .QSIFeedbackButton')) return false;
        return true;
    }

    function getClosestRestorableElement(element) {
        var current = element;
        while (current && current !== document.body && current !== document.documentElement) {
            if (isValidRestoreTarget(current)) return current;
            current = current.parentElement;
        }
        return null;
    }

    function findViewportRestoreTarget() {
        var viewportH = window.innerHeight || document.documentElement.clientHeight;
        var viewportMid = viewportH / 2;
        var bestEl = null;
        var bestDistance = Infinity;

        /* Prefer headings and paragraphs inside <main> to avoid
           sticky header or navigation links appearing first in DOM order. */
        var scopeSelectors = [
            'main h1, main h2, main h3, main h4, main h5, main h6, main p, main li',
            '[role="main"] h1, [role="main"] h2, [role="main"] h3, [role="main"] p',
            'h1, h2, h3, p',
        ];

        for (var s = 0; s < scopeSelectors.length; s++) {
            var candidates = document.querySelectorAll(scopeSelectors[s]);
            bestEl = null;
            bestDistance = Infinity;

            for (var i = 0; i < candidates.length; i++) {
                var el = candidates[i];
                if (!isValidRestoreTarget(el)) continue;
                var rect = el.getBoundingClientRect();
                if (rect.bottom < 0 || rect.top > viewportH) continue; /* not in viewport */
                var elMid = rect.top + rect.height / 2;
                var dist = Math.abs(elMid - viewportMid);
                if (dist < bestDistance) {
                    bestDistance = dist;
                    bestEl = el;
                }
            }

            if (bestEl) {
                return bestEl;
            }
        }

        return null;
    }

    function rememberCurrentFocus() {
        var active = document.activeElement;
        if (isValidRestoreTarget(active)) {
            lastFocusBeforeSurveyOpen = active;
            return;
        }

        if (isValidRestoreTarget(lastUserContextElement)) {
            lastFocusBeforeSurveyOpen = lastUserContextElement;
            return;
        }

        lastFocusBeforeSurveyOpen = findViewportRestoreTarget();
    }

    function restoreFocusAfterClose() {
        var target = lastFocusBeforeSurveyOpen;
        lastFocusBeforeSurveyOpen = null;

        if (!isValidRestoreTarget(target)) {
            return;
        }

        var restoreAnchor = null;
        var cleanupDone = false;
        var suppressedLauncherState = [];

        function isLauncherElement(el) {
            return !!(
                el &&
                (
                    el.id === 'QSIFeedbackButton-btn' ||
                    el.closest('#QSIFeedbackButton-target-container, .QSIFeedbackButton')
                )
            );
        }

        function createRestoreAnchor() {
            if (!target.parentNode) return null;

            var anchor = document.createElement('button');
            anchor.type = 'button';
            anchor.setAttribute('data-slideup-restore-anchor', 'true');
            anchor.setAttribute('tabindex', '-1');
            anchor.setAttribute('aria-label', 'Returned to the page content near where the feedback survey opened.');
            anchor.textContent = 'Returned to the page content near where the feedback survey opened.';
            anchor.style.cssText =
                'position:absolute;width:1px;height:1px;overflow:hidden;' +
                'clip:rect(0,0,0,0);white-space:nowrap;border:0;padding:0;margin:0;';

            target.parentNode.insertBefore(anchor, target);
            return anchor;
        }

        function suppressLauncherForRestore() {
            var launcher = getLauncherButton();
            var launcherWrapper = launcher && launcher.closest('.QSIFeedbackButton');
            var elements = [launcherWrapper, launcher];

            for (var i = 0; i < elements.length; i++) {
                var el = elements[i];
                if (!el || !document.contains(el)) continue;

                suppressedLauncherState.push({
                    element: el,
                    ariaHidden: el.getAttribute('aria-hidden'),
                    tabIndex: el.getAttribute('tabindex'),
                    disabled: typeof el.disabled === 'boolean' ? el.disabled : null,
                    inert: typeof el.inert === 'boolean' ? el.inert : null,
                });

                el.setAttribute('aria-hidden', 'true');
                el.setAttribute('tabindex', '-1');
                if (typeof el.disabled === 'boolean') {
                    el.disabled = true;
                }
                if (typeof el.inert === 'boolean') {
                    el.inert = true;
                }
            }
        }

        function restoreLauncherAfterRestore() {
            for (var i = 0; i < suppressedLauncherState.length; i++) {
                var state = suppressedLauncherState[i];
                var el = state.element;
                if (!el || !document.contains(el)) continue;

                if (state.ariaHidden === null) {
                    el.removeAttribute('aria-hidden');
                } else {
                    el.setAttribute('aria-hidden', state.ariaHidden);
                }

                if (state.tabIndex === null) {
                    el.removeAttribute('tabindex');
                } else {
                    el.setAttribute('tabindex', state.tabIndex);
                }

                if (typeof el.disabled === 'boolean' && state.disabled !== null) {
                    el.disabled = state.disabled;
                }

                if (typeof el.inert === 'boolean' && state.inert !== null) {
                    el.inert = state.inert;
                }
            }

            suppressedLauncherState = [];
        }

        function cleanupRestoreArtifacts() {
            if (cleanupDone) return;
            cleanupDone = true;

            document.removeEventListener('focusin', guardHandler, true);
            restoreLauncherAfterRestore();

            if (restoreAnchor && document.contains(restoreAnchor) && document.activeElement !== restoreAnchor) {
                restoreAnchor.remove();
            }
        }

        function doRestore(reason) {
            var focusTarget = restoreAnchor && document.contains(restoreAnchor) ? restoreAnchor : target;

            if (!focusTarget || typeof focusTarget.focus !== 'function' || !document.contains(focusTarget)) {
                return;
            }

            try {
                focusTarget.focus({ preventScroll: true });
            } catch (e) {
                focusTarget.focus();
            }
        }

        function guardHandler(event) {
            if (isLauncherElement(event.target)) {
                setTimeout(function () {
                    doRestore('guard');
                }, 0);
            } else if (restoreAnchor && event.target !== restoreAnchor && document.contains(restoreAnchor)) {
                restoreAnchor.remove();
                restoreAnchor = null;
            }
        }

        restoreAnchor = createRestoreAnchor();
        suppressLauncherForRestore();
        document.addEventListener('focusin', guardHandler, true);

        setTimeout(function () {
            cleanupRestoreArtifacts();
        }, 2500);

        setTimeout(function () {
            doRestore('initial');
        }, 400);
    }

    function stopAutoTriggers() {
        if (displayTimerId) {
            clearTimeout(displayTimerId);
            displayTimerId = null;
        }

        if (scrollHandlerAdded) {
            window.removeEventListener('scroll', onScroll, { passive: true });
            scrollHandlerAdded = false;
        }
    }

    function consumeAutoTrigger() {
        if (autoTriggerConsumed) return;
        autoTriggerConsumed = true;
        stopAutoTriggers();
    }

    function openViaQsiApi() {
        var api = window.QSI && window.QSI.API;
        if (!api) {
            return false;
        }

        try {
            if (typeof api.load === 'function') {
                api.load();
            }
        } catch (e) {
            window.QSI && QSI.dbg && QSI.dbg.e && QSI.dbg.e(e);
        }

        try {
            if (typeof api.run === 'function') {
                api.run();
                return true;
            }
        } catch (e2) {
            window.QSI && QSI.dbg && QSI.dbg.e && QSI.dbg.e(e2);
        }

        return false;
    }

    function clickLauncherSafely(button) {
        var cleanupHandlers = [];

        var form = button.closest('form');
        if (form) {
            var preventSubmit = function (e) {
                e.preventDefault();
            };
            form.addEventListener('submit', preventSubmit, true);
            cleanupHandlers.push(function () {
                form.removeEventListener('submit', preventSubmit, true);
            });
        }

        var link = button.closest('a[href]');
        if (link) {
            var preventNav = function (e) {
                e.preventDefault();
            };
            link.addEventListener('click', preventNav, true);
            cleanupHandlers.push(function () {
                link.removeEventListener('click', preventNav, true);
            });
        }

        button.click();

        setTimeout(function () {
            for (var i = 0; i < cleanupHandlers.length; i++) {
                cleanupHandlers[i]();
            }
        }, 0);
    }

    function requestSurveyOpen() {
        var attemptedOpen = false;

        if (openViaQsiApi()) {
            attemptedOpen = true;
        }

        /* Some Qualtrics intercepts expose API methods but do not actually open
             the feedback panel via run(). Fall back to launcher click unless the
             survey is already visibly open. */
        if (isSurveyCurrentlyOpen()) {
            return true;
        }

        var button = getLauncherButton();
        if (!button) {
            return attemptedOpen;
        }

        clickLauncherSafely(button);
        return true;
    }

    function focusAndAnnounceOpenIfReady() {
        if (!isSurveyCurrentlyOpen()) return;

        if (!openAnnouncementSent) {
            announce('Feedback survey opened. Focus moved to the survey.');
            openAnnouncementSent = true;
        }

        var frame = getSurveyFrame();
        if (frame && isElementA11yVisible(frame)) {
            if (!frame.getAttribute('title')) {
                frame.setAttribute('title', 'Feedback survey');
            }
            if (!frame.hasAttribute('tabindex')) {
                frame.setAttribute('tabindex', '-1');
            }

            /* Give VoiceOver a moment to speak the open announcement before
                 focus shifts into the survey/close control. */
            setTimeout(function () {
                if (isSurveyCurrentlyOpen()) {
                    frame.focus();
                }
            }, 500);
        }
    }

    function waitForSurveyOpenAndFocus() {
        var attempts = 0;
        var maxAttempts = 40;
        var stableOpenPolls = 0;
        var pollId = setInterval(function () {
            attempts++;

            var openNow = isSurveyCurrentlyOpen();

            /* Qualtrics assets can initialize after the 20% threshold is hit.
                 Retry a few times so late button/API availability still opens. */
            if (!openNow && attempts <= 20 && attempts % 3 === 1) {
                requestSurveyOpen();
            }

            if (openNow) {
                stableOpenPolls++;
            } else {
                stableOpenPolls = 0;
            }

            if (stableOpenPolls >= 2 || attempts >= maxAttempts) {
                clearInterval(pollId);
                isAutoOpening = false;

                if (stableOpenPolls >= 2) {
                    isSurveyOpen = true;
                    consumeAutoTrigger();
                    focusAndAnnounceOpenIfReady();
                }
            }
        }, 100);
    }

    function openSurveyAutomatically() {
        if (autoTriggerConsumed || isAutoOpening || isSurveyOpen) {
            return;
        }

        if (isSurveyCurrentlyOpen()) {
            isSurveyOpen = true;
            consumeAutoTrigger();
            focusAndAnnounceOpenIfReady();
            return;
        }

        isAutoOpening = true;
        rememberCurrentFocus();
        announceOpeningIfNeeded();

        setTimeout(function () {
            if (isSurveyCurrentlyOpen()) {
                isSurveyOpen = true;
                isAutoOpening = false;
                focusAndAnnounceOpenIfReady();
                return;
            }

            requestSurveyOpen();
            waitForSurveyOpenAndFocus();
        }, 300);
    }

    function addScrollHandler() {
        if (scrollHandlerAdded) return;
        window.addEventListener('scroll', onScroll, { passive: true });
        scrollHandlerAdded = true;
    }

    function addTimer() {
        displayTimerId = setTimeout(function () {
            displayTimerId = null;
            openSurveyAutomatically();
        }, displayAfterThisManySeconds * 1000);
    }

    function onScroll() {
        var now = Date.now();
        if (now - lastProcessedScrollEventTime < scrollThrottleMs) return;
        lastProcessedScrollEventTime = now;

        try {
            var docHeight = document.body.scrollHeight - document.documentElement.clientHeight;
            if (docHeight <= 0) return;

            var currentScrollPercentage = (window.scrollY / docHeight) * 100;
            if (currentScrollPercentage >= displayAfterUserScrollsPastPercentOfPage) {
                openSurveyAutomatically();
            }
        } catch (e) {
            window.QSI && QSI.dbg && QSI.dbg.e && QSI.dbg.e(e);
        }
    }

    function rememberUserContext(event) {
        var candidate = getClosestRestorableElement(event.target);
        if (candidate) {
            lastUserContextElement = candidate;
        }
    }

    function watchForManualOpenAndStateChanges() {
        document.addEventListener('focusin', rememberUserContext, true);
        document.addEventListener('click', rememberUserContext, true);
        document.addEventListener('touchstart', rememberUserContext, true);

        document.addEventListener(
            'click',
            function (event) {
                var launcher = event.target.closest('#QSIFeedbackButton-btn, .QSIFeedbackButton button');
                if (!launcher) return;

                if (!isSurveyOpen && !isAutoOpening) {
                    rememberCurrentFocus();
                }

                if (!isAutoOpening) {
                    consumeAutoTrigger();
                }
            },
            true
        );

        if (!window.MutationObserver) return;

        var observer = new MutationObserver(function () {
            var openNow = isSurveyCurrentlyOpen();

            if (!isSurveyOpen && openNow) {
                isSurveyOpen = true;
                focusAndAnnounceOpenIfReady();
            } else if (isSurveyOpen && !openNow) {
                isSurveyOpen = false;
                resetAnnouncements();
                restoreFocusAfterClose();
            }
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
        });
    }

})();