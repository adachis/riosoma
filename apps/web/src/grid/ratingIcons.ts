import { faStar, faHeart, faThumbsUp, faFlag, faCircle } from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@riosoma/icons';
import type { FieldOptionsOf } from '@riosoma/contracts';

export const ratingIcons: Record<FieldOptionsOf<'rating'>['icon'], IconDefinition> = {
  star: faStar,
  heart: faHeart,
  thumbsUp: faThumbsUp,
  flag: faFlag,
  circle: faCircle,
};
