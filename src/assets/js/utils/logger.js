/**
 * @author Luuxis
 * Licensed under CC BY-NC 4.0
 * https://creativecommons.org/licenses/by-nc/4.0/
 *
 * Edited by CentralCorp Team
 */
const console_log = console.log.bind(console);
const console_info = console.info.bind(console);
const console_warn = console.warn.bind(console);
const console_debug = console.debug.bind(console);
const console_error = console.error.bind(console);

class logger {
    constructor(name, color) {
        this.Logger(name, color);
    }

    Logger(name, color) {
        const prefix = `%c[${name}]:`;
        const style = `color: ${color};`;

        console.log = (...args) => {
            console_log(prefix, style, ...args);
        };

        console.info = (...args) => {
            console_info(prefix, style, ...args);
        };

        console.warn = (...args) => {
            console_warn(prefix, style, ...args);
        };

        console.debug = (...args) => {
            console_debug(prefix, style, ...args);
        };

        console.error = (...args) => {
            console_error(prefix, style, ...args);
        };
    }
}

export default logger;