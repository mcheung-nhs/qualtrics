(function () {
  /* Scroll depth (%) after which the survey is shown automatically.
     Set to 0 to disable scroll-triggered display. */
  var displayAfterUserScrollsPastPercentOfPage = 20;

  /* Seconds after page load before showing the survey.
     Set to 0 to disable time-triggered display. */
  var displayAfterThisManySeconds = 0;

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
  var displayTimerId = null;
  var scrollHandlerAdded = false;
  var lastProcessedScrollEventTime = new Date();
  var liveRegion = null;
  var escapeHandler = null;
  var surveyObserver = null;

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

  function getSurveyFrame() {
    return (
      document.querySelector('.QSIFeedbackButton iframe') ||
      document.querySelector('#ZN_eaDVkKUnDpnwcei iframe')
    );
  }

  function watchForManualOpen() {
    document.addEventListener(
      'click',
      function (event) {
        var launcher = event.target.closest('.QSIFeedbackButton button');
        if (launcher && !isAutoOpening && shouldConsumeTriggerOnManualOpen()) {
          consumeAutoTrigger();
        }
      },
      true
    );

    if (!window.MutationObserver) return;

    surveyObserver = new MutationObserver(function () {
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
    });
  }

  function openButton() {
    if (autoTriggerConsumed) return;

    try {
      var button = document.querySelector('.QSIFeedbackButton button');
      if (!button) return;

      if (shouldConsumeTriggerOnAutoOpen()) {
        consumeAutoTrigger();
      }
      isAutoOpening = true;

      /* Remember where focus was before we intervene, so we can restore it
         when the user closes the survey. */
      var previouslyFocused = document.activeElement;

      /* Announce to screen readers before opening so they hear the message
         before focus shifts. */
      announce('A short feedback survey is now available.');

      /* A brief delay lets the aria-live announcement be read first.
         Reduced for users who prefer less motion/animation. */
      var openDelay = prefersReducedMotion ? 0 : 300;

      setTimeout(function () {
        button.click();

        /* Poll for the survey iframe, then focus it. Qualtrics renders survey
           content inside a cross-origin iframe; focusing the iframe element
           itself is what moves VoiceOver's reading cursor into the panel.
           We poll rather than use a fixed delay because the iframe may take
           a variable amount of time to be injected into the DOM. */
        var pollAttempts = 0;
        var maxAttempts = prefersReducedMotion ? 5 : 20;
        var pollInterval = prefersReducedMotion ? 50 : 100;

        var pollForFrame = setInterval(function () {
          pollAttempts++;

          var surveyFrame = getSurveyFrame();

          if (surveyFrame || pollAttempts >= maxAttempts) {
            clearInterval(pollForFrame);
            isAutoOpening = false;

            if (surveyFrame) {
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
              surveyFrame.focus();
            } else {
              /* iframe never appeared — fall back to the toggle button. */
              button.focus();
            }

            announce('Feedback survey opened. Press Escape to close.');
          }
        }, pollInterval);

        /* Single, named Escape handler so it can be cleanly removed after
           use — no risk of duplicate listeners or memory leaks. */
        escapeHandler = function (e) {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          document.removeEventListener('keydown', escapeHandler);
          escapeHandler = null;

          button.click(); /* Close the panel. */
          announce('Feedback survey closed.');

          /* Return focus to wherever the user was before the survey opened. */
          setTimeout(function () {
            if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
              previouslyFocused.focus();
            }
          }, 100);
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
          openButton();
        }
      } catch (e) {
        window.QSI && QSI.dbg && QSI.dbg.e && QSI.dbg.e(e);
      }
    }
  }
})();