/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
'use strict';

class Slider {
    constructor(id, minValue, maxValue) {
        this.startX = 0;
        this.x = 0;

        this.slider = document.querySelector(id);
        this.touchLeft = this.slider.querySelector('.slider-touch-left');
        this.touchRight = this.slider.querySelector('.slider-touch-right');
        this.lineSpan = this.slider.querySelector('.slider-line span');

        this.min = parseFloat(this.slider.getAttribute('min'));
        this.max = parseFloat(this.slider.getAttribute('max'));

        this.minValue = minValue || this.min;
        this.maxValue = maxValue || this.max;

        this.step = parseFloat(this.slider.getAttribute('step'));
        this.normalizeFact = 18;

        this.reset();

        this.maxX = this.slider.offsetWidth - this.touchRight.offsetWidth;
        this.selectedTouch = null;
        this.initialValue = this.lineSpan.offsetWidth - this.normalizeFact;

        this.setMinValue(this.minValue);
        this.setMaxValue(this.maxValue);

        this.touchLeft.addEventListener('mousedown', (event) => this.onStart(event, this.touchLeft));
        this.touchRight.addEventListener('mousedown', (event) => this.onStart(event, this.touchRight));
        this.touchLeft.addEventListener('touchstart', (event) => this.onStart(event, this.touchLeft));
        this.touchRight.addEventListener('touchstart', (event) => this.onStart(event, this.touchRight));
    }

    reset() {
        this.touchLeft.style.left = '0px';
        this.touchRight.style.left = `${this.slider.offsetWidth - this.touchLeft.offsetWidth}px`;
        this.lineSpan.style.marginLeft = '0px';
        this.lineSpan.style.width = `${this.slider.offsetWidth - this.touchLeft.offsetWidth}px`;
        this.startX = 0;
        this.x = 0;
    }

    setMinValue(minValue) {
        const ratio = (minValue - this.min) / (this.max - this.min);
        this.touchLeft.style.left = `${Math.ceil(ratio * (this.slider.offsetWidth - (this.touchLeft.offsetWidth + this.normalizeFact)))}px`;
        this.lineSpan.style.marginLeft = `${this.touchLeft.offsetLeft}px`;
        this.lineSpan.style.width = `${this.touchRight.offsetLeft - this.touchLeft.offsetLeft}px`;
    }

    setMaxValue(maxValue) {
        const ratio = (maxValue - this.min) / (this.max - this.min);
        this.touchRight.style.left = `${Math.ceil(ratio * (this.slider.offsetWidth - (this.touchLeft.offsetWidth + this.normalizeFact)) + this.normalizeFact)}px`;
        this.lineSpan.style.marginLeft = `${this.touchLeft.offsetLeft}px`;
        this.lineSpan.style.width = `${this.touchRight.offsetLeft - this.touchLeft.offsetLeft}px`;
    }

    onStart(event, elem) {
        event.preventDefault();

        this.x = elem === this.touchLeft ? this.touchLeft.offsetLeft : this.touchRight.offsetLeft;
        this.startX = event.pageX - this.x;
        this.selectedTouch = elem;

        document.addEventListener('mousemove', this.onMove);
        document.addEventListener('mouseup', this.onStop);
        document.addEventListener('touchmove', this.onMove);
        document.addEventListener('touchend', this.onStop);
    }

    onMove = (event) => {
        this.x = event.pageX - this.startX;

        if (this.selectedTouch === this.touchLeft) {
            this.x = Math.max(0, Math.min(this.x, this.touchRight.offsetLeft - this.selectedTouch.offsetWidth - 24));
            this.selectedTouch.style.left = `${this.x}px`;
        } else if (this.selectedTouch === this.touchRight) {
            this.x = Math.max(this.touchLeft.offsetLeft + this.touchLeft.offsetWidth + 24, Math.min(this.x, this.maxX));
            this.selectedTouch.style.left = `${this.x}px`;
        }

        this.lineSpan.style.marginLeft = `${this.touchLeft.offsetLeft}px`;
        this.lineSpan.style.width = `${this.touchRight.offsetLeft - this.touchLeft.offsetLeft}px`;

        this.calculateValue();
    }

    onStop = () => {
        document.removeEventListener('mousemove', this.onMove);
        document.removeEventListener('mouseup', this.onStop);
        document.removeEventListener('touchmove', this.onMove);
        document.removeEventListener('touchend', this.onStop);

        this.selectedTouch = null;
        this.calculateValue();
    }

    calculateValue() {
        const newValue = (this.lineSpan.offsetWidth - this.normalizeFact) / this.initialValue;
        let minValue = this.lineSpan.offsetLeft / this.initialValue;
        let maxValue = minValue + newValue;

        minValue = minValue * (this.max - this.min) + this.min;
        maxValue = maxValue * (this.max - this.min) + this.min;

        if (this.step !== 0.0) {
            this.minValue = this.step * Math.floor(minValue / this.step);
            this.maxValue = this.step * Math.floor(maxValue / this.step);
        }

        this.emit('change', this.minValue, this.maxValue);
    }

    func = {};

    on(name, func) {
        this.func[name] = func;
    }

    emit(name, ...args) {
        if (this.func[name]) this.func[name](...args);
    }
}

export default Slider;