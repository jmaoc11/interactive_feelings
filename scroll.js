import { initScene, updateScene } from './scene.js';

// Scroll manager
class ScrollManager {
  constructor() {
    this.sections = new Map();
    this.activeSection = null;
    this.sceneInitialized = false;

    this.init();
  }

  init() {
    this.setupIntersectionObserver();
    this.setupScrollListener();
    this.initThreeScene();
    this.initLazyElements();
  }

  // IntersectionObserver for section visibility
  setupIntersectionObserver() {
    const options = {
      threshold: [0, 0.25, 0.5, 0.75, 1],
      rootMargin: '0px'
    };

    this.observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        const section = entry.target;
        const sectionName = section.dataset.section;

        if (entry.isIntersecting) {
          this.sections.set(sectionName, {
            element: section,
            isVisible: true,
            ratio: entry.intersectionRatio
          });

          // Handle section-specific visibility events
          this.onSectionEnter(section);
        } else {
          const sectionData = this.sections.get(sectionName);
          if (sectionData) {
            sectionData.isVisible = false;
          }

          this.onSectionExit(section);
        }
      });
    }, options);

    // Observe all sections
    document.querySelectorAll('[data-section]').forEach(section => {
      this.observer.observe(section);
    });
  }

  // Scroll listener for continuous progress tracking
  setupScrollListener() {
    let ticking = false;

    window.addEventListener('scroll', () => {
      if (!ticking) {
        window.requestAnimationFrame(() => {
          this.updateScrollProgress();
          ticking = false;
        });
        ticking = true;
      }
    });
  }

  updateScrollProgress() {
    // Update Three.js scene progress if it's visible
    const sceneSection = document.querySelector('[data-section="scene"]');
    if (sceneSection) {
      const progress = this.calculateSectionProgress(sceneSection);
      if (progress !== null) {
        updateScene(progress);
      }
    }
  }

  // Calculate scroll progress (0-1) for a section
  calculateSectionProgress(section) {
    const rect = section.getBoundingClientRect();
    const windowHeight = window.innerHeight;

    // Section hasn't entered yet
    if (rect.top > windowHeight) {
      return null;
    }

    // Section has completely passed
    if (rect.bottom < 0) {
      return null;
    }

    // Calculate progress based on wrapper height
    const sectionHeight = rect.height;
    const scrolled = windowHeight - rect.top;
    const totalScrollDistance = sectionHeight + windowHeight;

    const progress = Math.max(0, Math.min(1, scrolled / totalScrollDistance));
    return progress;
  }

  // Initialize Three.js scene
  initThreeScene() {
    const canvas = document.getElementById('scene-canvas');
    if (canvas && !this.sceneInitialized) {
      initScene(canvas);
      this.sceneInitialized = true;
    }
  }

  // Initialize lazy-loaded elements
  initLazyElements() {
    // Lazy video loading
    const lazyVideos = document.querySelectorAll('[data-lazy-video]');
    const videoObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const video = entry.target.querySelector('video');
          const src = video.dataset.src;

          if (src && !video.src) {
            video.src = src;
            video.load();
            video.play().catch(() => {
              // Auto-play blocked, user interaction needed
            });
          }
        } else {
          const video = entry.target.querySelector('video');
          if (video && video.src) {
            video.pause();
          }
        }
      });
    });

    lazyVideos.forEach(container => {
      videoObserver.observe(container);
    });

    // Lazy widget initialization
    const lazyWidgets = document.querySelectorAll('[data-lazy-widget]');
    const widgetObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          this.initWidget(entry.target);
        }
      });
    });

    lazyWidgets.forEach(widget => {
      widgetObserver.observe(widget);
    });
  }

  // Initialize widget (counter example)
  initWidget(widgetContainer) {
    if (widgetContainer.dataset.initialized) return;

    const increment = widgetContainer.querySelector('#increment');
    const decrement = widgetContainer.querySelector('#decrement');
    const count = widgetContainer.querySelector('#count');

    if (increment && decrement && count) {
      let value = 0;

      increment.addEventListener('click', () => {
        value++;
        count.textContent = value;
      });

      decrement.addEventListener('click', () => {
        value--;
        count.textContent = value;
      });

      widgetContainer.dataset.initialized = 'true';
    }
  }

  onSectionEnter(section) {
    const sectionName = section.dataset.section;
    console.log(`Section entered: ${sectionName}`);
  }

  onSectionExit(section) {
    const sectionName = section.dataset.section;
    console.log(`Section exited: ${sectionName}`);
  }
}

// Initialize on load
const scrollManager = new ScrollManager();

export { scrollManager };
