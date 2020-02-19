import * as t from '@/lib/io';
import Tone from 'tone';
import * as Audio from '@/lib/audio';
import { Beat } from '@/lib/audio/types';
import * as history from '@/core/project/history';
import { computed, Ref, ref, watch } from '@vue/composition-api';
import { Context } from '@/lib/audio';
import { Sample } from '@/models/sample';
import { Pattern } from '@/models/pattern';
import { AutomationClip } from '@/models/automation';
import { Instrument } from '@/models/instrument/instrument';
import { allKeys } from '@/utils';
import { BuildingBlock } from '@/models/block';
import { Disposer } from '@/lib/std';
import { emitter } from '@/lib/events';

export const createType = <T extends string>(type: T): SerializationType<T> => t.intersection([
  t.type({
    row: t.number,
    time: t.number,
    duration: t.number,
    id: t.string,
    type: t.literal<T>(type),
  }),
  t.partial({
    offset: t.number,
  }),
]);

type SerializationType<T extends string> = t.IntersectionC<[
  t.TypeC<{
    row: t.NumberC;
    time: t.NumberC;
    duration: t.NumberC;
    id: t.StringC;
    type: t.LiteralC<T>;
  }>,
  t.PartialC<{
    offset: t.NumberC;
  }>
]>;

interface ISchedulableCreate<T, M extends string> {
  component: string;
  showBorder: boolean;
  type: M;
  // TODO make a intersection type based on this!!
  offsettable?: boolean;
  add: (
    transport: Audio.Transport, params: SchedulableTemp<T, M>, idk: T,
  ) => Audio.TransportEventController | undefined;
}

const wrap = <T, K extends keyof T>(o: T, k: K, onSet: (value: T[K]) => void) => {
  const reference = ref(o[k]) as Ref<T[K]>;
  watch(reference, (value) => {
    onSet(value);
  }, { lazy: true });
  return reference;
};


export type SchedulableTemp<T, M extends string> = Readonly<{
  component: string;
  element: T;
  type: M;
  offsettable: boolean;
  copy: () => SchedulableTemp<T, M>;
  duration: Ref<number>;
  time: Ref<number>;
  offset: Ref<number>;
  row: Ref<number>;
  endBeat: Readonly<Ref<number>>;
  showBorder: boolean;
  name?: Readonly<Ref<string>>;
  slice: (timeToSlice: number) => SchedulableTemp<T, M> | undefined;
  // dispose: () => void;
  remove: () => void;
  removeNoHistory: () => void;
  serialize: () => t.TypeOf<SerializationType<M>>;
  onDidRemove: (cb: () => void) => Disposer;
  onUndidRemove: (cb: () => void) => Disposer;
}>;

interface Basics {
  duration: number;
  time: number;
  row: number;
  offset?: number;
}

const createSchedulable = <
  T extends BuildingBlock,
  M extends string,
>(o: ISchedulableCreate<T, M>) => {
  const create = (
    opts: Basics, idk: T, transport: Audio.Transport,
  ): SchedulableTemp<T, M> => {
    const info = {  ...opts };

    idk.onDidDelete(() => {
      removeNoHistory();
    });

    idk.onUndidDelete(() => {
      controller = o.add(transport, params, idk);
    });

    const duration = wrap(info, 'duration', (value) => {
      if (controller) { controller.setDuration(value); }
    });

    const time = wrap(info, 'time', (value) => {
      if (controller) { controller.setStartTime(value); }
    });

    const offset = computed({
      get: () => info.offset ?? 0,
      set: (value) => {
        info.offset = value;
        if (controller) { controller.setStartTime(value); }
      },
    });

    const row = ref(info.row);

    const copy = () => {
      // tslint:disable-next-line:no-console
      console.log(`Copying ${o.type} element!`);
      return create(info, idk, transport);
    };

    const removeNoHistory = () => {
      if (controller) {
        controller.remove();
        events.emit('remove');
      }
    };

    const remove = () => {
      history.execute({
        execute: () => {
          removeNoHistory();
        },
        undo: () => {
          if (controller) {
            controller.undoRemove();
            events.emit('undoRemove');
          }
        },

      });
    };


    const events = emitter<{ remove: [], undoRemove: [] }>();

    const params: SchedulableTemp<T, M> = {
      name: computed(() => idk.name),
      component: o.component,
      type: o.type,
      offsettable: o.offsettable ?? false,
      element: idk,
      duration,
      time,
      offset,
      row,
      copy,
      slice: (timeToSlice: Beat) => {
        if (timeToSlice <= time.value || timeToSlice >= time.value + duration.value) {
          return;
        }

        const newDuration = timeToSlice - time.value;
        const otherElementDuration = duration.value - newDuration;

        const newElement = copy();
        newElement.duration.value = otherElementDuration;
        duration.value = newDuration;

        if (o.offsettable) {
          newElement.offset.value = newDuration;
        } else {
          newElement.time.value += newDuration;
        }

        return newElement;
      },
      remove,
      removeNoHistory,
      endBeat: computed(() => {
        return time.value + duration.value;
      }),
      // dispose,
      serialize: () => {
        return {
          row: row.value,
          time: time.value,
          duration: duration.value,
          offset: offset.value,
          type: o.type,
          id: idk.id,
        };
      },
      onDidRemove: (cb: () => void) => {
        return events.on('remove', cb);
      },
      onUndidRemove: (cb: () => void) => {
        return events.on('undoRemove', cb);
      },
      showBorder: o.showBorder,
    } as const;

    // tslint:disable-next-line:no-console
    console.log('Creating scheduled element!');
    let controller = o.add(transport, params, idk);

    return params;
  };

  return {
    create: (opts: Basics, idk: T) => (transport: Audio.Transport) => create(opts, idk, transport),
    type: createType(o.type),
  };
};

export type UnscheduledPrototype<T = any, K extends string = any> =
  (transport: Audio.Transport) => SchedulableTemp<T, K>;

export const { create: createSamplePrototype, type: ScheduledSampleType } = createSchedulable({
  component: 'sample-element',
  type: 'sample',
  showBorder: true,
  offsettable: true,
  add: (transport, params, sample: Sample) => {
    if (!sample.player) {
      return;
    }

    const instance = sample.player.createInstance();
    let controller: { stop: (seconds: Audio.ContextTime) => void } | null = null;
    return transport.schedule({
      time: params.time.value,
      duration: params.duration.value,
      offset: 0,
      onStart: ({ seconds }) => {
        controller = instance.start({
          startTime: seconds,
          offset: params.offset.value || 0,
          duration: Context.beatsToSeconds(params.duration.value),
        });
      },
      onMidStart: ({ seconds, secondsOffset }) => {
        controller = instance.start({
          startTime: seconds,
          offset: secondsOffset,
          duration: Context.beatsToSeconds(params.duration.value),
        });
      },
      onEnd: ({ seconds }) => {
        // `controller` should never be null but we need to satisfy TypeScript
        // If, for some reason, it is null, then we don't really care about calling stop
        if (controller) {
          controller.stop(seconds);
        }
      },
    });
  },
});

export type ScheduledSample = SchedulableTemp<Sample, 'sample'>;

export const { create: createPatternPrototype, type: ScheduledPatternType } = createSchedulable({
  component: 'pattern-element',
  type: 'pattern',
  offsettable: true,
  showBorder: true,
  add: (transport, params, pattern: Pattern) => {
    return transport.embed(pattern.transport, params.time.value, params.duration.value);
  },
});

export type ScheduledPattern = SchedulableTemp<Pattern, 'pattern'>;

export const { create: createAutomationPrototype, type: ScheduledAutomationType } = createSchedulable({
  component: 'automation-clip-element',
  type: 'automation',
  offsettable: true,
  showBorder: true,
  add: (transport, params, clip: AutomationClip) => {
    return clip.control.sync(transport, params.time.value, params.duration.value);
  },
});

export type ScheduledAutomation = SchedulableTemp<AutomationClip, 'automation'>;

export const { create: createNotePrototype, type: ScheduledNoteType } = createSchedulable({
  component: 'note',
  type: 'note',
  offsettable: false,
  showBorder: false,
  add: (transport, params, instrument: Instrument<any, any>) => {
    return transport.schedule({
      onStart: ({ seconds }) => {
        const value = allKeys[params.row.value].value;
        const duration = new Tone.Ticks(params.duration.value * Audio.Context.PPQ).toSeconds();
        // TODO velocity
        instrument.triggerAttackRelease(value, duration, seconds, 1);
      },
      time: params.time.value,
      duration: 0, // FIXME We shouldn't have to set a duration. This is explained more in the Transport class file.
      offset: 0,
    });
  },
});

export type ScheduledNote = SchedulableTemp<Instrument<any, any>, 'note'>;
