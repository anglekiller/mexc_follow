import { Image } from 'react-native';

import { useGlass } from '../theme';

/** Coloured backdrop behind the glass panes. */
export function GlassBackdrop() {
  const on = useGlass();
  if (!on) return null;
  return (
    <Image
      source={require('../../assets/glass-bg.png')}
      resizeMode="cover"
      style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%' }}
    />
  );
}
