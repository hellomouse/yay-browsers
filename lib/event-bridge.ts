// throw events at node.js from the browser
import { JSHandle, Page, WebWorker } from 'puppeteer-core';
import EventEmitter from 'events';

export const CANCELLED = Symbol('cancelled');
export type EvalTarget = Page | WebWorker;

export interface RemoteEventBridge<T> {
  post: (event: T) => void;
  poll: () => Promise<T[]>;
}

function remoteCreateBridge<T>() {
  class RemoteEventBridgeImpl<U> {
    events: U[] = [];
    _waiter: (() => void) | null = null;

    post(event: U) {
      this.events.push(event);
      if (this._waiter) this._waiter();
    }

    poll(): Promise<U[]> {
      return new Promise(resolve => {
        if (this.events.length) {
          let ev = this.events;
          this.events = [];
          resolve(ev);
        } else {
          if (this._waiter) {
            throw new Error('cannot handle multiple waiters');
          }
          this._waiter = () => {
            if (!this.events.length) {
              throw new Error('waiter resumed with no events');
            }
            let ev = this.events;
            this.events = [];
            this._waiter = null;
            resolve(ev);
          };
        }
      });
    }
  }
  let remote: RemoteEventBridge<T> = new RemoteEventBridgeImpl<T>();
  return remote;
}

export interface EventBridgeEvents<T> {
  event: [T];
  disposed: [];
}

export class EventBridge<T> extends EventEmitter<EventBridgeEvents<T>> implements AsyncDisposable {
  _cancel: () => void;

  constructor(public handle: JSHandle<RemoteEventBridge<T>>) {
    super();

    let { promise: cancelSignal, resolve: cancelFn } = Promise.withResolvers<void>();
    this._cancel = cancelFn;
    (async () => {
      let cancelled: Promise<typeof CANCELLED> = cancelSignal.then(() => CANCELLED);
      let pollBridge = () => this.handle.evaluate(remote => remote.poll());
      loop: while (true) {
        let result;
        try {
          result = await Promise.race([
            cancelled,
            pollBridge(),
          ]);
        } catch (err) {
          console.warn('error from remote bridge:', err);
          break loop;
        }

        if (result === CANCELLED) {
          break loop;
        }
        for (let event of result) {
          this.emit('event', event);
        }
      }
      try {
        await this.handle.dispose();
      } catch (err) {
        // don't care
      }
      this.emit('disposed');
    })();
  }

  static async new<T>(target: EvalTarget): Promise<EventBridge<T>> {
    let handle = await target.evaluateHandle(remoteCreateBridge<T>);
    return new EventBridge<T>(handle);
  }

  async dispose() {
    return this._cancel();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}
