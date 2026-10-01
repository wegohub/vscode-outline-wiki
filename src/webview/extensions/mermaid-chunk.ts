import mermaid from 'mermaid';

/**
 * mermaid 懒加载 chunk：只有文档里出现 ```mermaid 围栏时，宿主/插件才会注入这个脚本。
 * 打成独立文件是为了不让主 bundle 白白背上 ~3MB。
 */
(window as unknown as { mermaid?: unknown }).mermaid = mermaid;
