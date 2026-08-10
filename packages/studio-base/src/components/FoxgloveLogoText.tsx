// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { makeStyles } from "tss-react/mui";

import logoTextUrl from "@foxglove/studio-base/assets/rui-xin-xing-text.png";

const useStyles = makeStyles()({
  root: {
    display: "block",
    maxWidth: "100%",
    height: "auto",
  },
});

export default function FoxgloveLogoText(props: { className?: string }): JSX.Element {
  const { classes, cx } = useStyles();

  return <img src={logoTextUrl} alt="睿芯行" className={cx(classes.root, props.className)} />;
}
