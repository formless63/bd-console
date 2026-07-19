// shoelace.js — self-hosted Shoelace bootstrap. Points the icon/asset base path
// at our vendored copy (no network fetches) and registers only the components we
// actually use. Importing a component file registers its custom element.

import { setBasePath } from '/vendor/shoelace/utilities/base-path.js';

setBasePath('/vendor/shoelace');

import '/vendor/shoelace/components/spinner/spinner.js';
import '/vendor/shoelace/components/tooltip/tooltip.js';
import '/vendor/shoelace/components/drawer/drawer.js';
import '/vendor/shoelace/components/tab-group/tab-group.js';
import '/vendor/shoelace/components/tab/tab.js';
import '/vendor/shoelace/components/tab-panel/tab-panel.js';
import '/vendor/shoelace/components/select/select.js';
import '/vendor/shoelace/components/option/option.js';
import '/vendor/shoelace/components/alert/alert.js';
