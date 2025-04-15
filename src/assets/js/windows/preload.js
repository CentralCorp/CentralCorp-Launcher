const { shell } = require('electron');

window.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a[target="_blank"]').forEach(link => {
        link.addEventListener('click', (event) => {
            event.preventDefault(); // зупиняємо стандартну поведінку
            shell.openExternal(link.href); // відкриваємо у браузері
        });
    });
});