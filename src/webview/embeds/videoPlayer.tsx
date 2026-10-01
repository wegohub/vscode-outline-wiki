import * as React from 'react';
import { prepareCompatibleVideo } from '../api.js';

interface Props { href: string; onError: (event: React.SyntheticEvent<HTMLMediaElement>) => void }
interface State { status: string; playbackHref?: string }

/** 一个原生 video 同时解码画面和声音；没有独立音轨或 JavaScript 同步循环。 */
export class VideoPlayer extends React.Component<Props, State> {
  override state: State = { status: '' };
  private video = React.createRef<HTMLVideoElement>();
  private alive = true;
  private requested = false;
  private preparing = false;
  private resumeAfterPrepare = false;
  private position = 0;
  private visibility = () => { if (document.hidden) this.video.current?.pause(); };
  override componentDidMount(): void { document.addEventListener('visibilitychange', this.visibility); }
  override componentWillUnmount(): void {
    this.alive = false;
    document.removeEventListener('visibilitychange', this.visibility);
    this.video.current?.pause();
  }
  private metadata = (): void => {
    const video = this.video.current;
    if (this.state.playbackHref) {
      if (video && this.position > 0) video.currentTime = this.position;
      if (video && this.resumeAfterPrepare) void video.play().catch(() => this.setState({ status: '声音已准备好，点击播放器的播放按钮继续。' }));
      return;
    }
    if (this.requested || !/\.(mp4|mov|m4v)$/i.test(this.props.href) || /^https?:/i.test(this.props.href)) return;
    this.requested = true;
    this.preparing = true;
    this.setState({ status: '正在准备视频声音，完成后使用播放器自带控件播放…' });
    void prepareCompatibleVideo(this.props.href).then(playbackHref => {
      if (!this.alive) return;
      this.position = this.video.current?.currentTime ?? 0;
      this.preparing = false;
      this.setState({ playbackHref, status: '' });
    }, error => {
      this.preparing = false;
      if (this.alive) this.setState({ status: (error as Error).message });
    });
  };
  private play = (): void => {
    if (this.preparing) {
      this.resumeAfterPrepare = true;
      this.video.current?.pause();
    } else if (this.state.status.startsWith('声音已准备好')) this.setState({ status: '' });
  };
  override render(): JSX.Element {
    return <div className="ow-video-player">
      <video ref={this.video} controls controlsList="nofullscreen" playsInline preload="metadata" src={this.state.playbackHref ?? this.props.href}
        onLoadedMetadata={this.metadata} onPlay={this.play} onError={this.props.onError} />
      {this.state.status && <div className="ow-video-status" role="status">{this.state.status}</div>}
    </div>;
  }
}
