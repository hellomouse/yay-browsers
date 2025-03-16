// throw events at node.js from the browser
import { JSHandle, Page, WebWorker } from 'puppeteer-core';
import EventEmitter from 'events';

export const CANCELLED = Symbol('cancelled');
export type EvalTarget = Page | WebWorker;

export interface RemoteEventBridge<T> {
  post: (event: T) => void;
  poll: (timeout?: number) => Promise<T[] | null>;
}

function remoteCreateBridge<T>() {
  class RemoteEventBridgeImpl<U> {
    events: U[] = [];
    _waiter: (() => void) | null = null;
    _deferredNotify = false;

    post(event: U) {
      this.events.push(event);
      if (this._waiter && !this._deferredNotify) {
        this._deferredNotify = true;
        queueMicrotask(() => {
          this._deferredNotify = false;
          if (this._waiter && this.events.length > 0) {
            this._waiter();
          }
        });
      }
    }

    poll(timeout?: number): Promise<U[] | null> {
      return new Promise(resolve => {
        if (this.events.length) {
          let ev = this.events;
          this.events = [];
          resolve(ev);
        } else {
          // note: strictly speaking, this type is wrong because this function runs in the browser, but whatever
          let timeoutId: NodeJS.Timeout;
          if (this._waiter) {
            throw new Error('cannot handle multiple waiters');
          }
          let waiter = () => {
            if (!this.events.length) {
              throw new Error('waiter resumed with no events');
            }
            clearTimeout(timeoutId);
            let ev = this.events;
            this.events = [];
            this._waiter = null;
            resolve(ev);
          };
          this._waiter = waiter;
          timeoutId = setTimeout(() => {
            if (Object.is(this._waiter, waiter)) {
              this._waiter = null;
              if (this.events.length) {
                let ev = this.events;
                this.events = [];
                resolve(ev);
              } else {
                resolve(null);
              }
            }
          }, timeout);
        }
      });
    }
  }
  let remote: RemoteEventBridge<T> = new RemoteEventBridgeImpl<T>();
  return remote;
}

export interface EventBridgeEvents<T> {
  event: [T];
  dispose: [];
}

export class EventBridge<T> extends EventEmitter<EventBridgeEvents<T>> implements AsyncDisposable {
  _cancel: () => void;
  _worker: Promise<void>;
  active = true;

  constructor(
    public handle: JSHandle<RemoteEventBridge<T>>,
    public readonly pollTimeout = 120_000
  ) {
    super();
    let { promise: cancelSignal, resolve: cancelFn } = Promise.withResolvers<void>();
    this._cancel = cancelFn;
    this._worker = (async () => {
      let cancelled: Promise<typeof CANCELLED> = cancelSignal.then(() => CANCELLED);
      let pollBridge = () =>
        this.handle.evaluate((remote, timeout) => remote.poll(timeout), this.pollTimeout);
      let needsDispose = true;
      while (true) {
        let result;
        try {
          result = await Promise.race([cancelled, pollBridge()]);
        } catch (err) {
          if (err instanceof Error && err?.name === 'TargetCloseError') {
            needsDispose = false;
          } else {
            console.warn('error from remote bridge:', err);
          }
          break;
        }

        if (result === CANCELLED) break;
        if (result === null) continue;
        for (let event of result) {
          this.emit('event', event);
        }
      }
      if (needsDispose) {
        try {
          await this.handle.dispose();
        } catch (err) {
          // don't care
        }
      }
    })().finally(() => {
      this.active = false;
      this.emit('dispose');
    });
  }

  static async new<T>(target: EvalTarget, timeout?: number): Promise<EventBridge<T>> {
    let handle = await target.evaluateHandle(remoteCreateBridge<T>);
    return new EventBridge<T>(handle, timeout);
  }

  async dispose() {
    this._cancel();
    await this._worker;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}
