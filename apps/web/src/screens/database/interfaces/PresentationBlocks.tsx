import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useLingui } from '@lingui/react/macro';
import { useQuery } from '@tanstack/react-query';
import { idsOf, type HeroBlock, type MediaBlock, type RecordAttachment } from '@riosoma/contracts';
import type { BlockContext } from './context';
import { MarkdownText } from './MarkdownText';
import { ButtonBody } from './SmallBlocks';

function Video({
  src,
  poster,
  alt,
  playback,
}: {
  src: string;
  poster?: string;
  alt: string;
  playback?: 'controls' | 'loop';
}) {
  const player = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const video = player.current;
    if (!video || playback !== 'loop') return;
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => {
      video.muted = true;
      video.volume = 0;
      video.controls = motion.matches;
      if (motion.matches) {
        video.pause();
        video.currentTime = 0;
      } else
        void video.play().catch(() => {
          video.controls = true;
        });
    };
    update();
    motion.addEventListener('change', update);
    return () => motion.removeEventListener('change', update);
  }, [src, playback]);
  return (
    <video
      ref={player}
      src={src}
      controls
      preload="metadata"
      playsInline
      poster={poster}
      aria-label={alt}
      muted={playback === 'loop'}
      loop={playback === 'loop'}
      onVolumeChange={
        playback === 'loop'
          ? (event) => {
              if (!event.currentTarget.muted) event.currentTarget.muted = true;
              if (event.currentTarget.volume !== 0) event.currentTarget.volume = 0;
            }
          : undefined
      }
    />
  );
}

function Picture({ src, alt, enlarge }: { src: string; alt: string; enlarge?: boolean }) {
  const { t } = useLingui();
  const description = alt;
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLAnchorElement>(null);
  const picture = (
    <span className="rio-interface-picture">
      <img src={src} alt={alt} />
    </span>
  );
  if (!enlarge) return picture;
  return (
    <>
      <a
        ref={trigger}
        href={src}
        className="rio-interface-enlarge"
        aria-label={
          description
            ? t({ id: 'interfaces.media.enlarge.description', message: `Enlarge image: ${description}` })
            : t({ id: 'interfaces.media.enlarge.open', message: 'Enlarge image' })
        }
        onClick={(event) => {
          event.preventDefault();
          dialog.current?.showModal();
        }}
      >
        {picture}
      </a>
      <dialog
        ref={dialog}
        className="rio-interface-image-dialog"
        aria-label={alt || t({ id: 'interfaces.media.enlarge.open', message: 'Enlarge image' })}
        onClose={() => trigger.current?.focus()}
      >
        <button type="button" autoFocus onClick={() => dialog.current?.close()}>
          {t({ id: 'interfaces.media.enlarge.close', message: 'Close image' })}
        </button>
        <img src={src} alt={alt} />
      </dialog>
    </>
  );
}

export function RecordMedia({
  reference,
  kind = 'image',
  alt,
  context,
  playback,
  enlarge,
}: {
  reference: RecordAttachment | null;
  kind?: 'image' | 'video';
  playback?: 'controls' | 'loop';
  enlarge?: boolean;
  alt: string;
  context: BlockContext;
}) {
  const { session } = context;
  const tableId = reference?.tableId;
  const recordId = reference?.recordId;
  useQuery({
    queryKey: ['interfaceMedia', session.databaseId, tableId, recordId],
    enabled: Boolean(reference),
    queryFn: () => session.getRecord(reference!.tableId, reference!.recordId),
  });
  // Snapshot rows survive trashing for open grids, so media also follows trash and restore events.
  const source = useMemo(() => {
    let removed = false;
    return {
      subscribe: (listener: () => void) =>
        tableId && recordId
          ? session.subscribeRecords(tableId, (changed, change) => {
              if (!changed.has(recordId)) return;
              if (change?.kind === 'record.trashed') removed = true;
              if (change?.kind === 'record.restored') removed = false;
              listener();
            })
          : () => undefined,
      getSnapshot: () =>
        tableId && recordId && !removed ? session.cachedRecord(tableId, recordId) : undefined,
    };
  }, [session, tableId, recordId]);
  const record = useSyncExternalStore(source.subscribe, source.getSnapshot);
  const ids = useMemo(
    () => (reference ? idsOf(record?.values[reference.fieldId] ?? null) : []),
    [record, reference],
  );
  useEffect(() => {
    session.ensureAttachments(ids);
  }, [session, ids]);
  useSyncExternalStore(
    (listener) => session.subscribeAttachments(listener),
    () => ids.map((id) => session.attachments.get(id)?.url ?? '').join('|'),
  );
  const file =
    reference && ids.includes(reference.attachmentId)
      ? session.attachments.get(reference.attachmentId)
      : null;
  if (!file?.url || file.scanState !== 'clean') return null;
  const poster = ids
    .map((id) => session.attachments.get(id))
    .find((item) => item?.type.startsWith('image/') && item.scanState === 'clean');
  return kind === 'image' && file.type.startsWith('image/') ? (
    <Picture src={file.url} alt={alt} enlarge={enlarge} />
  ) : kind === 'video' && file.type.startsWith('video/') ? (
    <Video src={file.url} poster={poster?.url} alt={alt || file.name} playback={playback} />
  ) : null;
}

export function HeroBody({ block, context }: { block: HeroBlock; context: BlockContext }) {
  return (
    <div className="rio-interface-hero">
      <div>
        <h3>{block.heading}</h3>
        <div className="rio-interface-text rio-interface-lead">
          <MarkdownText text={block.text} />
        </div>
        <div className="rio-interface-hero__actions">
          {block.buttons.map((button, index) => (
            <ButtonBody
              key={index}
              block={{ id: block.id, place: block.place, title: '', kind: 'button', ...button }}
              context={context}
            />
          ))}
        </div>
      </div>
      <RecordMedia
        reference={block.image}
        kind={block.mediaType}
        alt={block.alt}
        context={context}
        playback={block.playback}
      />
    </div>
  );
}
export function MediaBody({ block, context }: { block: MediaBlock; context: BlockContext }) {
  return (
    <figure className="rio-interface-media">
      <RecordMedia
        reference={block.attachment}
        kind={block.mediaType}
        playback={block.playback}
        enlarge={block.enlarge}
        alt={block.alt || block.caption}
        context={context}
      />
      {block.caption ? <figcaption>{block.caption}</figcaption> : null}
    </figure>
  );
}
