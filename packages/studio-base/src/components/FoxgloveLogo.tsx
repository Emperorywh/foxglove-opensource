// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { makeStyles } from "tss-react/mui";

import logoUrl from "@foxglove/studio-base/assets/rui-xin-xing-logo.png";

const useStyles = makeStyles()({
  root: {
    display: "block",
    width: "auto",
    height: "1em",
  },
});

export function FoxgloveLogo(props: { className?: string }): JSX.Element {
  const { classes, cx } = useStyles();

  return <img src={logoUrl} alt="睿芯行" className={cx(classes.root, props.className)} />;
}
