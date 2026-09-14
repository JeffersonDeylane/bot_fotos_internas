export class SendQueue {
  private tail = Promise.resolve();
  constructor(private readonly delayMs = 750) {}
  enqueue(task: () => Promise<void>): Promise<void> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => {}).then(() => new Promise(resolve => setTimeout(resolve, this.delayMs)));
    return result;
  }
  async drain(): Promise<void> { await this.tail; }
}

