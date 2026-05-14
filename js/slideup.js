(function () {
  if (window.__qualtricsSlideupInitDone) {
    return;
  }
  window.__qualtricsSlideupInitDone = true;

  /* Scroll depth (%) after which the survey is shown automatically.
     Set to 0 to disable scroll-triggered display. */
  var displayAfterUserScrollsPastPercentOfPage = 20;

  /* Seconds after page load before showing the survey.
     Set to 0 to disable time-triggered display. */
  var displayAfterThisManySeconds = 0;

  /* Set to true while testing to log survey state transitions. */
  var debugSurveyState = true;

  /* Manual-open policy.
     'disable-future-auto-open': a manual open prevents later scroll/timer auto-open
     'ignore-manual-open': a manual open does not affect later auto-open */
  var manualOpenPolicy = 'disable-future-auto-open';

  /* Automatic trigger policy.
     'once-per-page': the automatic trigger can only run once per page load
     'repeatable': the automatic trigger may run again if your logic allows it */
  var autoOpenPolicy = 'once-per-page';

  var autoTriggerConsumed = false;
  var isAutoOpening = false;
  var isSurveyOpen = false;
  var displayTimerId = null;
  var scrollHandlerAdded = false;
  var lastProcessedScrollEventTime = new Date();
  var liveRegion = null;
  var escapeHandler = null;
  var surveyObserver = null;
  var lastFocusBeforeSurveyOpen = null;
  var lastSurveyOpenedAt = 0;
  var closeConfirmTimerId = null;

  /* Respect the user's operating system preference to reduce motion. */
  var prefersReducedMotion =
    window.matchMedia
      ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
      : false;

  if (displayAfterThisManySeconds) {
    addTimer();
  }

  if (displayAfterUserScrollsPastPercentOfPage) {
    addScrollHandler();
  }

  watchForManualOpen();

  /* Creates a visually-hidden aria-live region used to announce state
     changes to screen readers without moving visible focus. */
  function getOrCreateLiveRegion() {
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

  /* Sends a polite announcement to screen readers. Clears first to ensure
     repeated identical messages are still surfaced. */
  function announce(message) {
    var region = getOrCreateLiveRegion();
    region.textContent = '';
    setTimeout(function () {
      region.textContent = message;
    }, 50);
  }

  function shouldConsumeTriggerOnManualOpen() {
    return manualOpenPolicy === 'disable-future-auto-open';
  }

  function shouldConsumeTriggerOnAutoOpen() {
    return autoOpenPolicy === 'once-per-page';
  }

  function debugLog(message, metadata) {
    if (!debugSurveyState || !window.console || !console.log) return;
    if (metadata) {
      console.log('[slideup]', message, metadata);
    } else {
      console.log('[slideup]', message);
    }
  }

  function rememberFocusBeforeOpen() {
    lastFocusBeforeSurveyOpen = document.activeElement;
    debugLog('Remembered focus before survey open.', {
      tagName:
        lastFocusBeforeSurveyOpen && lastFocusBeforeSurveyOpen.tagName
          ? lastFocusBeforeSurveyOpen.tagName
          : null,
    });
  }

  function isUsableFocusTarget(element) {
    return (
      !!element &&
      element !== document.body &&
      element !== document.documentElement &&
      typeof element.focus === 'function' &&
      document.contains(element)
    );
  }

  function restoreFocusAfterClose() {
    var restoreTarget = isUsableFocusTarget(lastFocusBeforeSurveyOpen)
      ? lastFocusBeforeSurveyOpen
      : document.querySelector('.QSIFeedbackButton button');

    lastFocusBeforeSurveyOpen = null;

    if (!restoreTarget || typeof restoreTarget.focus !== 'function') {
      debugLog('No valid element available for focus restore.');
      return;
    }

    setTimeout(function () {
      try {
        restoreTarget.focus({ preventScroll: true });
      } catch (e) {
        restoreTarget.focus();
      }
      debugLog('Focus restored after survey close.');
    }, 100);
  }

  function markSurveyOpened() {
    lastSurveyOpenedAt = Date.now();
    if (closeConfirmTimerId) {
      clearTimeout(closeConfirmTimerId);
      closeConfirmTimerId = null;
    }
  }

  function scheduleConfirmedCloseHandling() {
    if (closeConfirmTimerId) return;

    closeConfirmTimerId = setTimeout(function () {
      closeConfirmTimerId = null;

      /* During desktop animation/layout transitions Qualtrics may briefly
         report a closed-like state; only act when it remains closed. */
      if (isSurveyCurrentlyOpen()) {
        debugLog('Ignoring transient close state; survey is still open.');
        return;
      }

      isSurveyOpen = false;
      debugLog('Survey close confirmed after debounce.');
      restoreFocusAfterClose();
    }, 300);
  }

  /* Safely click the Qualtrics launcher button without triggering form
     submission or anchor navigation, both of which reload the page on
     iOS Safari. */
  function clickLauncherSafely(button) {
    var handlers = [];

    var form = button.closest('form');
    if (form) {
      var preventSubmit = function (e) { e.preventDefault(); };
      form.addEventListener('submit', preventSubmit, true);
      handlers.push(function () { form.removeEventListener('submit', preventSubmit, true); });
    }

    var anchor = button.closest('a[href]');
    if (anchor) {
      var preventNav = function (e) { e.preventDefault(); };
      anchor.addEventListener('click', preventNav, true);
      handlers.push(function () { anchor.removeEventListener('click', preventNav, true); });
    }

    button.click();

    /* Remove the temporary guards after the event has propagated. */
    setTimeout(function () {
      for (var i = 0; i < handlers.length; i++) { handlers[i](); }
    }, 0);
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
    debugLog('Auto trigger consumed.');
    stopAutoTriggers();
  }

  function getSurveyFrame() {
    return (
      document.querySelector('.QSIFeedbackButton iframe') ||
      document.querySelector('#ZN_eaDVkKUnDpnwcei iframe')
    );
  }

  /* Best-effort visibility check so we can mirror Qualtrics open/close
     state even when users close via Qualtrics UI controls. */
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
    return (
      !!element &&
      !element.closest('[aria-hidden="true"], [hidden], [inert]')
    );
  }

  function isSurveyCurrentlyOpen() {
    var surveyFrame = getSurveyFrame();
    if (!surveyFrame) return false;

    var panel = surveyFrame.closest(
      '.QSIWebResponsiveDialog-Layout1-SI_Container, .QSIPopOver, .QSIContainer, #ZN_eaDVkKUnDpnwcei, #QSIFeedbackButton-target-container'
    );

    if (isElementVisible(surveyFrame) && (!panel || isElementVisible(panel))) {
      return true;
    }

    return false;
  }

  function watchForManualOpen() {
    document.addEventListener(
      'click',
      function (event) {
        var launcher = event.target.closest('.QSIFeedbackButton button');
        var launcherLink = event.target.closest('.QSIFeedbackButton a[href="#"]');

        if (launcherLink) {
          /* Prevent hash navigation (jump to top) when VoiceOver activates
             launcher markup wrapped in href="#" links on iOS Safari. */
          event.preventDefault();
        }

        if (launcher && !isSurveyOpen && !isAutoOpening) {
          rememberFocusBeforeOpen();
        }

        if (launcher && !isAutoOpening && shouldConsumeTriggerOnManualOpen()) {
          consumeAutoTrigger();
        }
      },
      true
    );

    if (!window.MutationObserver) return;

    surveyObserver = new MutationObserver(function () {
      var surveyIsOpenNow = isSurveyCurrentlyOpen();

      if (!isSurveyOpen && surveyIsOpenNow) {
        isSurveyOpen = true;
        markSurveyOpened();
        debugLog('Survey marked open from observer.');
      } else if (isSurveyOpen && !surveyIsOpenNow) {
        if (Date.now() - lastSurveyOpenedAt < 1000) {
          debugLog('Ignoring immediate post-open close signal.', {
            msSinceOpen: Date.now() - lastSurveyOpenedAt,
          });
          return;
        }

        debugLog('Potential survey close detected; waiting to confirm.');
        scheduleConfirmedCloseHandling();
      }

      if (
        isAutoOpening ||
        autoTriggerConsumed ||
        !shouldConsumeTriggerOnManualOpen()
      ) {
        return;
      }

      if (getSurveyFrame()) {
        consumeAutoTrigger();
      }
    });

    surveyObserver.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });
  }

  function openButton() {
    if (autoTriggerConsumed || isAutoOpening || isSurveyOpen) {
      debugLog('Auto-open skipped.', {
        autoTriggerConsumed: autoTriggerConsumed,
        isAutoOpening: isAutoOpening,
        isSurveyOpen: isSurveyOpen,
      });
      return;
    }

    try {
      var button = document.querySelector('.QSIFeedbackButton button');
      if (!button) {
        debugLog('Auto-open skipped: launcher button not found.');
        return;
      }

      if (shouldConsumeTriggerOnAutoOpen()) {
        consumeAutoTrigger();
      }
      isAutoOpening = true;
      debugLog('Starting auto-open flow.');
      rememberFocusBeforeOpen();

      /* Announce to screen readers before opening so they hear the message
         before focus shifts. */
      announce('A short feedback survey is now available.');

      /* A brief delay lets the aria-live announcement be read first.
         Reduced for users who prefer less motion/animation. */
      var openDelay = prefersReducedMotion ? 0 : 300;

      setTimeout(function () {
        if (isSurveyOpen || isSurveyCurrentlyOpen()) {
          isAutoOpening = false;
          markSurveyOpened();
          debugLog('Skipping auto-open click: survey already open before click.');
          return;
        }

        clickLauncherSafely(button);

        /* Poll for the survey iframe, then focus it. Qualtrics renders survey
           content inside a cross-origin iframe; focusing the iframe element
           itself is what moves VoiceOver's reading cursor into the panel.
           We poll rather than use a fixed delay because the iframe may take
           a variable amount of time to be injected into the DOM. */
        var pollAttempts = 0;
        var stableOpenPolls = 0;
        var maxAttempts = prefersReducedMotion ? 8 : 40;
        var pollInterval = prefersReducedMotion ? 50 : 100;

        var pollForFrame = setInterval(function () {
          pollAttempts++;

          var surveyFrame = getSurveyFrame();
          var surveyIsOpenNow = isSurveyCurrentlyOpen();
          if (surveyIsOpenNow) {
            stableOpenPolls++;
          } else {
            stableOpenPolls = 0;
          }

          if (stableOpenPolls >= 2 || pollAttempts >= maxAttempts) {
            clearInterval(pollForFrame);
            isAutoOpening = false;

            if (stableOpenPolls >= 2 && surveyFrame) {
              isSurveyOpen = true;
              markSurveyOpened();
              debugLog('Survey iframe detected and marked open.');
              /* Ensure the iframe has a label so screen readers announce
                 what it contains when focus enters it. */
              if (!surveyFrame.getAttribute('title')) {
                surveyFrame.setAttribute('title', 'Feedback survey');
              }
              /* tabindex="-1" lets us programmatically focus an iframe
                 that doesn't already have a tabindex. */
              if (!surveyFrame.hasAttribute('tabindex')) {
                surveyFrame.setAttribute('tabindex', '-1');
              }
              if (isElementA11yVisible(surveyFrame)) {
                surveyFrame.focus();
              } else {
                debugLog('Skipping iframe focus until it is accessibility-visible.');
              }

              announce('Feedback survey opened. Press Escape to close.');
            } else {
              /* Survey never reached a confirmed visible/open state. */
              debugLog('Survey did not reach a confirmed open state before timeout.');
              button.focus();
            }
          }
        }, pollInterval);

        /* Single, named Escape handler so it can be cleanly removed after
           use — no risk of duplicate listeners or memory leaks. */
        escapeHandler = function (e) {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          document.removeEventListener('keydown', escapeHandler);
          escapeHandler = null;

          clickLauncherSafely(button); /* Close the panel. */
          isSurveyOpen = false;
          lastSurveyOpenedAt = 0;
          if (closeConfirmTimerId) {
            clearTimeout(closeConfirmTimerId);
            closeConfirmTimerId = null;
          }
          debugLog('Survey closed via Escape key.');
          announce('Feedback survey closed.');
          restoreFocusAfterClose();
        };

        document.addEventListener('keydown', escapeHandler);
      }, openDelay);
    } catch (e) {
      /* Only emit errors in Qualtrics debug mode. */
      window.QSI && QSI.dbg && QSI.dbg.e && QSI.dbg.e(e);
    }
  }

  function addScrollHandler() {
    if (!scrollHandlerAdded) {
      /* passive:true tells the browser this handler never calls
         preventDefault(), allowing it to optimise scroll performance. */
      window.addEventListener('scroll', onScroll, { passive: true });
      scrollHandlerAdded = true;
    }
  }

  function addTimer() {
    displayTimerId = setTimeout(function () {
      displayTimerId = null;
      openButton();
    }, displayAfterThisManySeconds * 1000);
  }

  function onScroll() {
    var now = new Date();
    if (now - lastProcessedScrollEventTime > 100) {
      lastProcessedScrollEventTime = now;
      try {
        var docHeight =
          document.body.scrollHeight - document.documentElement.clientHeight;
        if (docHeight <= 0) return;

        var currentScrollPercentage = (window.scrollY / docHeight) * 100;

        if (currentScrollPercentage >= displayAfterUserScrollsPastPercentOfPage) {
          debugLog('Scroll threshold reached.', {
            currentScrollPercentage: currentScrollPercentage,
            threshold: displayAfterUserScrollsPastPercentOfPage,
          });
          openButton();
        }
      } catch (e) {
        window.QSI && QSI.dbg && QSI.dbg.e && QSI.dbg.e(e);
      }
    }
  }
})();