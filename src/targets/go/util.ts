export interface Stringable {
    toString(): string;
}

export class WriteCollector implements Stringable {

    protected data = new Array<Stringable>();

    /**
     * Write appends data to the collector for later usage.
     */
    write(data: Stringable): WriteCollector {
        this.data.push(data);
        return this;
    }

    toString(): string {
        return this.data.map(d => d.toString()).join("");
    }
}