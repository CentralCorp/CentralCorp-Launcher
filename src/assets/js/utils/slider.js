/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

const THUMB_WIDTH_PX = 20;
const HALF_THUMB_PX = THUMB_WIDTH_PX / 2;

class Slider {
    constructor(id, minValue, maxValue) {
        this.slider = typeof id === 'string' ? document.querySelector(id) : id;
        if (!this.slider) return;

        // Clean up listeners from any previous Slider instance bound to the same DOM node
        if (typeof this.slider._sliderCleanup === 'function') {
            this.slider._sliderCleanup();
        }

        this.touchLeft = this.slider.querySelector('.slider-touch-left');
        this.touchRight = this.slider.querySelector('.slider-touch-right');
        this.line = this.slider.querySelector('.slider-line');
        this.lineSpan = this.slider.querySelector('.slider-line span');

        this.min = parseFloat(this.slider.getAttribute('min'));
        if (!Number.isFinite(this.min)) this.min = 0.5;

        this.max = parseFloat(this.slider.getAttribute('max'));
        if (!Number.isFinite(this.max) || this.max < this.min) this.max = this.min;

        const parsedStep = parseFloat(this.slider.getAttribute('step'));
        this.step = Number.isFinite(parsedStep) && parsedStep > 0 ? parsedStep : 0.5;

        const initMin = Number.isFinite(minValue) ? minValue : this.min;
        const initMax = Number.isFinite(maxValue) ? maxValue : this.max;

        this.minValue = this.clampAndSnap(initMin);
        this.maxValue = Math.max(this.minValue, this.clampAndSnap(initMax));
        this.selectedTouch = null;
        this.func = {};

        this.renderPositions();

        const onLeftMouseDown = (e) => this.onStart(e, this.touchLeft);
        const onRightMouseDown = (e) => this.onStart(e, this.touchRight);
        const onLeftTouchStart = (e) => this.onStart(e, this.touchLeft);
        const onRightTouchStart = (e) => this.onStart(e, this.touchRight);
        const onTrackClick = (e) => this.onTrackPointerDown(e);

        this.touchLeft.addEventListener('mousedown', onLeftMouseDown);
        this.touchRight.addEventListener('mousedown', onRightMouseDown);
        this.touchLeft.addEventListener('touchstart', onLeftTouchStart, { passive: false });
        this.touchRight.addEventListener('touchstart', onRightTouchStart, { passive: false });
        this.slider.addEventListener('mousedown', onTrackClick);

        this.slider._sliderCleanup = () => {
            this.onStop();
            this.touchLeft.removeEventListener('mousedown', onLeftMouseDown);
            this.touchRight.removeEventListener('mousedown', onRightMouseDown);
            this.touchLeft.removeEventListener('touchstart', onLeftTouchStart);
            this.touchRight.removeEventListener('touchstart', onRightTouchStart);
            this.slider.removeEventListener('mousedown', onTrackClick);
        };
    }

    clampAndSnap(rawVal) {
        if (this.max <= this.min) return this.min;
        const clamped = Math.max(this.min, Math.min(this.max, rawVal));
        const steps = Math.round((clamped - this.min) / this.step);
        const snapped = this.min + steps * this.step;
        const rounded = Math.round(snapped * 100) / 100;
        return Math.max(this.min, Math.min(this.max, rounded));
    }

    valueToRatio(val) {
        if (this.max <= this.min) return 0;
        return Math.max(0, Math.min(1, (val - this.min) / (this.max - this.min)));
    }

    pointerToValue(event) {
        const rect = this.slider.getBoundingClientRect();
        const usableWidth = Math.max(1, rect.width - THUMB_WIDTH_PX);
        const point = event.touches && event.touches.length ? event.touches[0] : event;
        const rawRatio = Math.max(
            0,
            Math.min(1, (point.clientX - rect.left - HALF_THUMB_PX) / usableWidth)
        );
        return this.clampAndSnap(this.min + rawRatio * (this.max - this.min));
    }

    renderPositions() {
        const leftRatio = this.max <= this.min ? 0 : this.valueToRatio(this.minValue);
        const rightRatio = this.max <= this.min ? 1 : this.valueToRatio(this.maxValue);

        this.touchLeft.style.left = `calc(${leftRatio * 100}% - ${leftRatio * THUMB_WIDTH_PX}px)`;
        this.touchRight.style.left = `calc(${rightRatio * 100}% - ${rightRatio * THUMB_WIDTH_PX}px)`;
        this.touchLeft.style.zIndex = leftRatio > 0.9 ? '4' : '3';
        this.touchRight.style.zIndex = leftRatio > 0.9 ? '3' : '4';

        this.lineSpan.style.marginLeft = `${leftRatio * 100}%`;
        this.lineSpan.style.width = `${Math.max(0, (rightRatio - leftRatio) * 100)}%`;
    }

    setMinValue(minValue) {
        this.minValue = Math.min(this.clampAndSnap(minValue), this.maxValue);
        this.renderPositions();
    }

    setMaxValue(maxValue) {
        this.maxValue = Math.max(this.minValue, this.clampAndSnap(maxValue));
        this.renderPositions();
    }

    onTrackPointerDown(event) {
        if (
            this.touchLeft.contains(event.target) ||
            this.touchRight.contains(event.target)
        ) {
            return;
        }
        const clickedVal = this.pointerToValue(event);
        const distLeft = Math.abs(clickedVal - this.minValue);
        const distRight = Math.abs(clickedVal - this.maxValue);
        const chosen =
            distLeft < distRight || (distLeft === distRight && clickedVal < this.minValue)
                ? this.touchLeft
                : this.touchRight;

        this.applyThumbValue(chosen, clickedVal);
        this.onStart(event, chosen);
    }

    onStart(event, elem) {
        event.preventDefault();
        event.stopPropagation();
        this.selectedTouch = elem;

        document.addEventListener('mousemove', this.onMove);
        document.addEventListener('mouseup', this.onStop);
        document.addEventListener('touchmove', this.onMove, { passive: false });
        document.addEventListener('touchend', this.onStop);
    }

    applyThumbValue(elem, targetVal) {
        const prevMin = this.minValue;
        const prevMax = this.maxValue;

        if (elem === this.touchLeft) {
            // If both handles overlap and user drags past maxValue to the right, switch to right thumb
            if (this.minValue === this.maxValue && targetVal > this.maxValue) {
                this.selectedTouch = this.touchRight;
                this.maxValue = targetVal;
            } else {
                this.minValue = Math.min(targetVal, this.maxValue);
            }
        } else if (elem === this.touchRight) {
            if (this.minValue === this.maxValue && targetVal < this.minValue) {
                this.selectedTouch = this.touchLeft;
                this.minValue = targetVal;
            } else {
                this.maxValue = Math.max(targetVal, this.minValue);
            }
        }

        this.renderPositions();
        if (this.minValue !== prevMin || this.maxValue !== prevMax) {
            this.emit('change', this.minValue, this.maxValue);
        }
    }

    onMove = (event) => {
        if (!this.selectedTouch) return;
        if (event.cancelable) event.preventDefault();
        const nextVal = this.pointerToValue(event);
        this.applyThumbValue(this.selectedTouch, nextVal);
    };

    onStop = () => {
        document.removeEventListener('mousemove', this.onMove);
        document.removeEventListener('mouseup', this.onStop);
        document.removeEventListener('touchmove', this.onMove);
        document.removeEventListener('touchend', this.onStop);
        this.selectedTouch = null;
    };

    on(name, fn) {
        this.func[name] = fn;
    }

    emit(name, ...args) {
        if (this.func[name]) this.func[name](...args);
    }
}

export default Slider;