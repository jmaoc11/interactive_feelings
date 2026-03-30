import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { initScene, updateScene } from './scene.js';

// Register ScrollTrigger plugin
gsap.registerPlugin(ScrollTrigger);

// Scroll manager with GSAP ScrollTrigger
class ScrollManager {
  constructor() {
    this.sceneInitialized = false;
    this.scrollTriggers = [];

    this.init();
  }

  init() {
    this.initThreeScene();
    this.setupScrollTriggers();
    this.initLazyElements();
  }

  // Initialize Three.js scene
  initThreeScene() {
    const canvas = document.getElementById('scene-canvas');
    if (canvas && !this.sceneInitialized) {
      initScene(canvas);
      this.sceneInitialized = true;
    }
  }

  // Setup GSAP ScrollTriggers
  setupScrollTriggers() {
    // Three.js scene scroll trigger
    const sceneSection = document.querySelector('[data-section="scene"]');
    if (sceneSection) {
      const trigger = ScrollTrigger.create({
        trigger: sceneSection,
        start: 'top top',
        end: 'bottom bottom',
        scrub: true,
        onUpdate: (self) => {
          // self.progress gives us 0-1 as we scroll through the section
          updateScene(self.progress);
        },
        onEnter: () => console.log('Scene section entered'),
        onLeave: () => console.log('Scene section left'),
        onEnterBack: () => console.log('Scene section entered (scrolling up)'),
        onLeaveBack: () => console.log('Scene section left (scrolling up)')
      });

      this.scrollTriggers.push(trigger);
    }

    // Example: Add scroll triggers for other sections
    const proseSection = document.querySelector('[data-section="intro"]');
    if (proseSection) {
      const trigger = ScrollTrigger.create({
        trigger: proseSection,
        start: 'top center',
        end: 'bottom center',
        onEnter: () => console.log('Intro section entered'),
        onLeave: () => console.log('Intro section left')
      });

      this.scrollTriggers.push(trigger);
    }
  }

  // Initialize lazy-loaded elements (keeping IntersectionObserver for efficiency)
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

  // Cleanup method (useful if you need to destroy and recreate)
  destroy() {
    this.scrollTriggers.forEach(trigger => trigger.kill());
    this.scrollTriggers = [];
  }
}

// Initialize on load
const scrollManager = new ScrollManager();

export { scrollManager };
