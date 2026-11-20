import { Trans, useLingui } from '@lingui/react/macro';
import type { UpdateRelease, UpdateStatus } from '@riosoma/contracts';
import { Text } from '@riosoma/ui';

/**
 * The image digest the signed feed names for where this install runs: this server's platform, or
 * `linux/amd64` on Cloud Run, which runs nothing else.  None when the server's platform isn't one
 * releases name.
 */
function signedDigest(status: UpdateStatus, release: UpdateRelease): string | undefined {
  const platform = status.install === 'cloud-run' ? 'linux/amd64' : status.platform;
  return platform ? release.images[platform] : undefined;
}

/**
 * The commands that update this kind of install, filled in with the release.  They're the same as
 * the upgrade section of each install guide, so the notice and the guide never disagree.  Images
 * are pulled by the digest the signed feed names, which nobody can move the way a tag can be
 * moved, whenever the feed names one for this platform.  The connector service's image, beside
 * Riosoma's in the same registry, goes by the release's tag, since Riosoma's own image names its
 * digest.  Commands aren't words, so they stay as they are in every language.
 */
function commands(status: UpdateStatus, release: UpdateRelease): string[] {
  const version = release.version;
  const digest = signedDigest(status, release);
  const image = `${status.repository}:${version}${digest ? `@${digest}` : ''}`;
  const connectors = `${status.repository}-connectors:${version}`;
  switch (status.install) {
    case 'compose':
      return [
        'docker compose run --rm backup once',
        `sed -i.bak -e 's|^RIOSOMA_IMAGE=.*|RIOSOMA_IMAGE=${image}|' -e 's|^RIOSOMA_CONNECTORS_IMAGE=.*|RIOSOMA_CONNECTORS_IMAGE=${connectors}|' .env`,
        'docker compose pull riosoma connectors',
        'docker compose up -d',
      ];
    case 'docker':
      return [`docker pull ${image}`, `docker pull ${connectors}`];
    case 'helm':
      return [
        `helm upgrade riosoma ./deploy/helm/riosoma -n riosoma -f values.yaml --set image.tag=${version}${
          digest ? ` --set image.digest=${digest}` : ''
        }`,
        'kubectl -n riosoma rollout status deployment/riosoma --timeout=15m',
        'kubectl -n riosoma rollout status deployment/riosoma-connectors --timeout=5m',
      ];
    case 'kubernetes':
      return [
        `kubectl -n riosoma set image deployment/riosoma-connectors connectors=${connectors}`,
        `kubectl -n riosoma set image deployment/riosoma riosoma=${image}`,
        'kubectl -n riosoma rollout status deployment/riosoma --timeout=15m',
      ];
    case 'container-apps':
      return [
        `az containerapp update -g $RG -n $APP --container-name connectors --image ${connectors}`,
        `az containerapp update -g $RG -n $APP --container-name riosoma --image ${image}`,
      ];
    case 'ecs':
      return [
        `sed -i.bak -e 's|${status.repository}-connectors:[^"]*|${connectors}|' -e 's|${status.repository}:[^"]*|${image}|' task-definition.json`,
        'aws ecs register-task-definition --cli-input-json file://task-definition.json',
        'aws ecs update-service --cluster riosoma --service riosoma --task-definition riosoma',
        'aws ecs wait services-stable --cluster riosoma --services riosoma',
      ];
    case 'cloud-run':
      return [
        `docker pull --platform linux/amd64 ${image}`,
        `docker tag ${image} $REPO/riosoma:${version}`,
        `docker push $REPO/riosoma:${version}`,
        `docker pull --platform linux/amd64 ${connectors}`,
        `docker tag ${connectors} $REPO/riosoma-connectors:${version}`,
        `docker push $REPO/riosoma-connectors:${version}`,
        `gcloud run deploy riosoma --region=$REGION --container=riosoma --image=$REPO/riosoma:${version} --container=connectors --image=$REPO/riosoma-connectors:${version}`,
      ];
    case 'source':
      return [
        `git fetch --tags && git checkout v${version}`,
        'pnpm install --frozen-lockfile',
        'pnpm turbo run build --filter=@riosoma/server... --filter=@riosoma/web',
      ];
  }
}

/** How to update by hand, for installs the updater doesn't run */
export function UpdateSteps({ status, release }: { status: UpdateStatus; release: UpdateRelease }) {
  const { t } = useLingui();
  const pinned = Boolean(signedDigest(status, release)) || status.install === 'source';
  return (
    <div className="rio-updates__steps">
      <Text>
        {status.install === 'docker' ? (
          <Trans id="updates.steps.docker">
            Back up the database, pull the new image, and start a new container from it with the same settings
            and volumes as this one.
          </Trans>
        ) : status.install === 'source' ? (
          <Trans id="updates.steps.source">
            Back up the database, check out the release, rebuild, and restart the server.
          </Trans>
        ) : (
          t({
            id: 'updates.steps.intro',
            message:
              'Back up the database first, then run these.  The new version brings the database up to date when it starts.',
          })
        )}
      </Text>
      <pre
        className="rio-updates__commands"
        tabIndex={0}
        aria-label={t({ id: 'updates.steps.commands', message: 'Commands to update' })}
      >
        <code>{commands(status, release).join('\n')}</code>
      </pre>
      {pinned ? null : (
        <Text variant="small">
          {t({
            id: 'updates.steps.byTag',
            message:
              'The update feed names no image for this server’s platform, so these commands pull the release by its tag.',
          })}
        </Text>
      )}
    </div>
  );
}
