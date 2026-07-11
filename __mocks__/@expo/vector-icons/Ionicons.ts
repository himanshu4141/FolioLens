import React from 'react';

type IconProps = Record<string, unknown> & { children?: React.ReactNode };

const Ionicons = Object.assign(
  function MockIonicons({ children, ...props }: IconProps) {
    return React.createElement('Ionicons', props, children);
  },
  { glyphMap: {} as Record<string, number> },
);

export default Ionicons;
