import BlockMenu from 'rich-markdown-editor/dist/components/BlockMenu.js';
import { AttachmentIcon } from 'outline-icons';
import { post } from '../api.js';

// 归档库没有菜单扩展口；只扩展 items getter，不改 nodeView、schema 或依赖。
const baseItems = Object.getOwnPropertyDescriptor(BlockMenu.prototype, 'items')!.get!;
Object.defineProperty(BlockMenu.prototype, 'items', {
  configurable: true,
  get(this: BlockMenu) {
    return [...baseItems.call(this), { name: 'ow_local_video', title: '视频',
      keywords: '视频 video 本机 local upload', icon: AttachmentIcon }];
  }
});

export function localVideoExtension(): unknown {
  return { type: 'extension', name: 'ow_local_video', bindEditor() {},
    commands: () => () => () => { post({ type: 'requestLocalVideo' }); return true; }
  };
}
