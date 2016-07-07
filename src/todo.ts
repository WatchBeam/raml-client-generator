import * as chalk from "chalk";
const figures = require("figures");

/**
 * Todo pretty-prints a list of tasks in the console. Tasks are started
 * and finished, printing to the console each time. It's assumed that
 * all tasks are done serially.
 */
export class Todo {

    private stream: any;
    private current: string;
    private timeStart: number;

    constructor() {
        this.stream = process.stderr;
    }

    private writeMessage(msg: string) {
        this.stream.cursorTo(0);
        this.stream.write(msg);
        this.stream.clearLine(1);
    }

    start(name: string) {
        if (this.current) {
            this.finish();
        }

        this.writeMessage(` ${chalk.yellow(figures.pointer)} ${name}`);
        this.current = name;
        this.timeStart = Date.now();
    }

    finish() {
        const delta = Date.now() - this.timeStart;
        this.writeMessage(` ${chalk.green(figures.tick)} ${this.current} ${chalk.dim(`(${delta}ms)`)}\n`);
    }
}