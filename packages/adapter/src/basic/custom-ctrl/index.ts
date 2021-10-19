import { EditorState, Plugin, PluginKey, Transaction } from 'prosemirror-state';
import { EditorProps, EditorView } from 'prosemirror-view';

import { SylApi } from '../../api';
import { filterData, groupData, toArray, Types } from '../../libs';
import { IEventHandler, SylController } from '../../schema';
import { CtrlPlugin } from '../ctrl-plugin';

type ValueOf<T> = T[keyof T];
type TEventHandler = (adapter: SylApi, ...args: any[]) => any;
type TransEventHandler = (adapter: SylApi, data: any) => any;
type TDomEventHandlersMap = Partial<
  Record<
    keyof NonNullable<IEventHandler['handleDOMEvents']>,
    Array<ValueOf<NonNullable<IEventHandler['handleDOMEvents']>>>
  >
>;
type THandlersCenter = Partial<
  Record<keyof Omit<IEventHandler, 'handleDOMEvents'>, Array<TEventHandler>> & { handleDOMEvents: TDomEventHandlersMap }
>;

const transEvents = ['transformPastedHTML', 'transformPastedText', 'clipboardTextParser', 'transformPasted'];

// transEvents means only transport one parameter
const transEventChain = (adapter: SylApi, handles: Array<TransEventHandler>, ...content: any) => {
  if (!adapter.view.editable) return content[0];
  return handles.reduce((_res, handle: (adapter: SylApi, data: any) => any) => {
    const res = handle(adapter, _res);
    return res;
  }, content[0]);
};
const chainEvent = (
  event: string,
  adapter: SylApi,
  handlers: Array<TEventHandler | TransEventHandler | Types.StringMap<any>>,
  ...args: any[]
): any => {
  if (transEvents.includes(event)) {
    return transEventChain(adapter, handlers as TransEventHandler[], ...args);
  }

  if (!adapter.view.editable) return false;
  return handlers.some(handler => (handler as TEventHandler)(adapter, ...args));
};
interface ICustomCtrlConfig extends EditorProps {
  eventHandler?: IEventHandler;
  appendTransaction?: SylController['appendTransaction'];
}

class CustomCtrlCenter {
  private adapter: SylApi;
  private appendTransactions: Array<NonNullable<SylController['appendTransaction']>> = [];
  private eventHandler: THandlersCenter = {};
  private props: EditorProps = {};

  // group appendTransaction handler
  private handleAppendTransaction = (trs: Transaction[], oldState: EditorState, _newState: EditorState) => {
    let newState = _newState;
    const tr = newState.tr;
    let appended = false;
    this.appendTransactions.forEach(handler => {
      const res = handler(tr, oldState, newState);
      if (res) {
        newState = _newState.applyInner(res);
        appended = true;
      }
    });
    if (appended) return tr;
  };

  private defaultDomEventHandler = (event: Event) =>
    this.adapter.view.someProp('handleDOMEvents', handlers => {
      const handler = handlers[event.type];
      return handler ? handler(this.adapter.view, event) || event.defaultPrevented : false;
    });

  private ensureDOMEvents = () => {
    const { view } = this.adapter;
    view.someProp('handleDOMEvents', (currentHandlers: EditorView['eventHandlers']) => {
      for (const type in currentHandlers) {
        if (!view.eventHandlers[type])
          view.dom.addEventListener(
            type,
            (view.eventHandlers[type] = (event: Event) => this.defaultDomEventHandler(event)),
          );
      }
    });
  };

  // assigned `this.props` according to `eventHandler`
  private handleProps = () => {
    (Object.keys(this.eventHandler) as Array<keyof IEventHandler>).reduce((result, event: keyof IEventHandler) => {
      let handler;
      // collect domEvent handlers and chain
      if (event === 'handleDOMEvents') {
        handler = (Object.keys(this.eventHandler.handleDOMEvents!) as Array<keyof TDomEventHandlersMap>).reduce(
          (res, domEvent: keyof TDomEventHandlersMap) => {
            res[domEvent] = (...args: any[]) =>
              chainEvent(domEvent, this.adapter, this.eventHandler.handleDOMEvents![domEvent] as any, ...args);
            return res;
          },
          {} as any,
        );
      } else {
        // simple chain the custom event handler
        handler = (...args: any[]) =>
          chainEvent(event, this.adapter, this.eventHandler[event] as Array<TEventHandler>, ...args);
      }

      result[event as keyof EditorProps] = handler;
      return result;
    }, this.props);
    this.ensureDOMEvents();
  };

  public register = (registerConfigs: ICustomCtrlConfig | Array<ICustomCtrlConfig>) => {
    toArray(registerConfigs).forEach(config => {
      (Object.keys(config) as Array<keyof ICustomCtrlConfig>).forEach((configName: keyof ICustomCtrlConfig) => {
        if (configName === 'appendTransaction') {
          this.appendTransactions.push(config.appendTransaction!);
        } else if (configName === 'eventHandler') {
          const eventHandler = config.eventHandler;
          (Object.keys(eventHandler!) as Array<keyof IEventHandler>).forEach((event: keyof IEventHandler) => {
            const handler = eventHandler![event];
            if (!handler) return;
            if (event === 'handleDOMEvents') {
              if (!this.eventHandler.handleDOMEvents) this.eventHandler.handleDOMEvents = {};
              const domEventHandler = handler as NonNullable<IEventHandler['handleDOMEvents']>;
              (Object.keys(domEventHandler) as Array<keyof NonNullable<IEventHandler['handleDOMEvents']>>).forEach(
                (key: keyof NonNullable<IEventHandler['handleDOMEvents']>) => {
                  if (!domEventHandler[key]) return;
                  groupData(this.eventHandler.handleDOMEvents, key, domEventHandler[key]);
                },
              );
            } else {
              groupData(this.eventHandler, event, handler);
            }
          });
        } else {
          // @ts-ignore
          this.props[configName] = config[configName];
        }
      });
    });
    this.handleProps();
  };

  public unregister = (registerConfigs: ICustomCtrlConfig | Array<ICustomCtrlConfig>) => {
    toArray(registerConfigs).forEach(config => {
      (Object.keys(config) as Array<keyof ICustomCtrlConfig>).forEach((configName: keyof ICustomCtrlConfig) => {
        if (configName === 'appendTransaction') {
          filterData(this, 'appendTransactions', config.appendTransaction);
        } else if (configName === 'eventHandler') {
          (Object.keys(config.eventHandler!) as Array<keyof IEventHandler>).forEach((key: keyof IEventHandler) => {
            if (key === 'handleDOMEvents') {
              (Object.keys(config.eventHandler!.handleDOMEvents!) as Array<keyof TDomEventHandlersMap>).forEach(
                (key: keyof TDomEventHandlersMap) => {
                  if (!this.eventHandler.handleDOMEvents?.[key]) return;
                  filterData(this.eventHandler.handleDOMEvents, key, config.eventHandler!.handleDOMEvents![key]);
                },
              );
            } else if (this.eventHandler[key]) {
              filterData(this.eventHandler, key, config.eventHandler![key]);
            }
          });
        } else {
          // @ts-ignore
          this.props[configName] = undefined;
        }
      });
    });

    this.handleProps();
  };

  constructor(adapter: SylApi, configs?: Array<ICustomCtrlConfig>) {
    this.adapter = adapter;
    if (configs) this.register(configs);
  }

  public spec: Plugin['spec'] = {
    key: new PluginKey('customControl'),
    props: this.props,
    appendTransaction: this.handleAppendTransaction,
  };
}

const createCustomCtrlPlugin = (adapter: SylApi, customProps?: Array<ICustomCtrlConfig>) => {
  const ctrlCenter = new CustomCtrlCenter(adapter, customProps);
  return new CtrlPlugin<ICustomCtrlConfig | Array<ICustomCtrlConfig>>(ctrlCenter.spec, ctrlCenter);
};

export { createCustomCtrlPlugin, ICustomCtrlConfig };
