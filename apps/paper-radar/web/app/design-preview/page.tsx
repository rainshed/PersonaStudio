'use client';
import Link from 'next/link';

import {
  Bell,
  BookOpen,
  CalendarDays,
  Check,
  ChevronDown,
  ExternalLink,
  FileSearch,
  FlaskConical,
  Languages,
  Menu,
  PanelLeftClose,
  Radar,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import './preview.css';

type Paper = {
  id: string;
  arxiv: string;
  title: string;
  authors: string;
  summary: string;
  reason: string;
  tags: string[];
  status: string;
};

const papers: Paper[] = [
  {
    id: 'ising',
    arxiv: '2609.10670v1',
    title:
      '3d Ising Field Theory with Magnetic Deformation: Fuzzy Sphere Meets TCSA',
    authors: 'Giulia Fardelli, A. Liam Fitzpatrick, Emanuel Katz, Yuan Xin',
    summary:
      '研究磁场形变下的 (2+1)d Ising Field Theory，并比较 Fuzzy Sphere、TCSA、ED 与 DMRG 的数值结果。',
    reason:
      '这篇论文与您对多体数值方法的兴趣有直接的方法层匹配。作者在具体的 Fuzzy Sphere Hamiltonian 上使用 ED，并在更大系统中使用 DMRG，再与基于 CFT data 的 TCSA 对照。它对截断误差、曲率修正和有限尺寸外推的处理，能够直接补充您已有的数值计算经验。',
    tags: ['数值多体', 'ED', 'Tensor Network'],
    status: '完整报告已就绪',
  },
  {
    id: 'ginsburg',
    arxiv: '2609.10678v1',
    title:
      'Geometric Ginzburg–Landau Theory of Charge Ordering and Commensurability',
    authors:
      'Aneesh Agarwal, Rutvij Gholap, Mohammad Saeed Bahramy, Robert-Jan Slager',
    summary:
      '提出 geometric Ginzburg–Landau theory，解释 flat-band 体系中的 quantum geometry 如何促进 CDW formation。',
    reason:
      '论文把量子几何与序参量理论联系起来，适合作为您研究凝聚态多体问题时的跨方向参考。',
    tags: ['凝聚态', 'Quantum Geometry'],
    status: '可生成完整报告',
  },
  {
    id: 'magnon',
    arxiv: '2609.10708v1',
    title:
      'A Unified Theory of Collective Magnon and Orbiton Excitations in Altermagnets',
    authors: 'Bishal Das, Chanchal K. Barman, Aftab Alam',
    summary:
      '构建 spin–orbital model，研究 altermagnets 中相互依赖但不杂化的 magnon 与 orbiton。',
    reason:
      '它提供了处理耦合自由度的一套清晰框架，并包含有限温重整化与 Monte Carlo 对比。',
    tags: ['Altermagnet', 'Spin–orbital'],
    status: '可生成完整报告',
  },
];

const navItems = [
  { label: '每日论文', icon: BookOpen, active: true },
  { label: '单篇分析', icon: FileSearch },
  { label: '我的订阅', icon: Users },
  { label: '评测与改进', icon: FlaskConical },
  { label: '设置', icon: Settings2 },
];

export default function DesignPreview() {
  const [selectedId, setSelectedId] = useState(papers[0].id);
  const [activeTab, setActiveTab] = useState<'overview' | 'report'>('overview');
  const [focused, setFocused] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const paper = papers.find((item) => item.id === selectedId) ?? papers[0];

  return (
    <main className={`concept-page${focused ? ' is-focused' : ''}`}>
      <aside className={`concept-sidebar${mobileNav ? ' is-open' : ''}`}>
        <Link className="concept-brand" href="/" aria-label="返回 Paper Radar">
          <span className="concept-brand-mark">
            <Radar size={22} />
          </span>
          <span>
            <strong>Paper Radar</strong>
            <small>RESEARCH STUDIO</small>
          </span>
        </Link>

        <nav aria-label="主导航">
          {navItems.map(({ label, icon: Icon, active }) => (
            <button
              key={label}
              className={active ? 'active' : ''}
              type="button"
            >
              <Icon size={18} />
              <span>{label}</span>
            </button>
          ))}
        </nav>

        <div className="concept-sidebar-footer">
          <div className="concept-language">
            <Languages size={15} />
            <span>界面语言</span>
            <button type="button">中文</button>
          </div>
          <p>
            <span className="status-dot" />
            本地数据已连接
          </p>
          <small>AI Persona · Revision 12</small>
        </div>
      </aside>

      <section className="concept-main">
        <header className="concept-topbar">
          <button
            className="mobile-nav-button"
            type="button"
            onClick={() => setMobileNav(!mobileNav)}
            aria-label="打开菜单"
          >
            <Menu size={20} />
          </button>
          <div className="concept-breadcrumb">
            <span>研究工作台</span>
            <b>/</b>
            <strong>每日论文</strong>
          </div>
          <div className="concept-top-actions">
            <span className="preview-pill">视觉演示 · 不影响现有数据</span>
            <button className="icon-button" type="button" aria-label="通知">
              <Bell size={18} />
              <i>2</i>
            </button>
          </div>
        </header>

        <div className="concept-content">
          <div className="concept-heading">
            <div>
              <p className="concept-kicker">TODAY · 2026.09.11</p>
              <h1>每日论文</h1>
              <p>先看与你的研究方向最相关、最值得投入时间的内容。</p>
            </div>
            <div className="heading-actions">
              <button className="secondary-button" type="button">
                管理订阅
              </button>
              <button className="primary-button" type="button">
                <RefreshCw size={17} />
                生成最新一批
              </button>
            </div>
          </div>

          <section className="control-card" aria-label="日报设置">
            <div className="control-field wide">
              <span>当前订阅</span>
              <button type="button">
                <strong>量子物理 · Physics</strong>
                <small>cond-mat.stat-mech + quant-ph</small>
                <ChevronDown size={16} />
              </button>
            </div>
            <div className="control-field">
              <span>公告日期</span>
              <button type="button">
                <CalendarDays size={17} />
                <strong>2026-09-11</strong>
                <ChevronDown size={16} />
              </button>
            </div>
            <div className="run-summary">
              <span className="run-check">
                <Check size={15} />
              </span>
              <div>
                <strong>筛选完成</strong>
                <small>101 篇论文 · 13 篇推荐</small>
              </div>
              <button type="button">查看记录</button>
            </div>
          </section>

          <div className="filter-row">
            <div className="filter-tabs" role="tablist" aria-label="论文筛选">
              <button className="active" type="button">
                推荐 <b>13</b>
              </button>
              <button type="button">
                不推荐 <b>88</b>
              </button>
              <button type="button">
                待判断 <b>0</b>
              </button>
              <button type="button">
                版本更新 <b>81</b>
              </button>
            </div>
            <label className="paper-search">
              <Search size={17} />
              <input type="search" placeholder="搜索标题或作者" />
            </label>
          </div>

          <section className="reader-card">
            <div className="paper-list" aria-label="推荐论文列表">
              <div className="paper-list-head">
                <div>
                  <strong>推荐论文</strong>
                  <span>13 篇</span>
                </div>
                <small>按相关度排序</small>
              </div>
              {papers.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  className={`paper-item${selectedId === item.id ? ' selected' : ''}`}
                  onClick={() => {
                    setSelectedId(item.id);
                    setActiveTab('overview');
                  }}
                  aria-current={selectedId === item.id ? 'true' : undefined}
                >
                  <div className="paper-item-meta">
                    <span>{item.arxiv}</span>
                    <span>推荐理由</span>
                  </div>
                  <h2>{item.title}</h2>
                  <p className="paper-authors">{item.authors}</p>
                  <p className="paper-summary">{item.summary}</p>
                  <div className="paper-item-footer">
                    <span>{item.status}</span>
                    <span aria-hidden="true">→</span>
                  </div>
                </button>
              ))}
            </div>

            <article className="paper-reader">
              <div className="reader-toolbar">
                <span>{paper.arxiv}</span>
                <div>
                  <button type="button" onClick={() => setFocused(!focused)}>
                    <PanelLeftClose size={16} />
                    {focused ? '退出专注' : '专注阅读'}
                  </button>
                  <a href="#paper-source">
                    arXiv <ExternalLink size={15} />
                  </a>
                </div>
              </div>

              <header className="reader-heading">
                <div className="reader-badges">
                  <span>推荐阅读</span>
                  <small>{paper.status}</small>
                </div>
                <h2>{paper.title}</h2>
                <p>{paper.authors}</p>
                <div className="reader-tags">
                  {paper.tags.map((tag) => (
                    <span key={tag}>{tag}</span>
                  ))}
                </div>
              </header>

              <div className="reader-tabs" role="tablist" aria-label="论文内容">
                <button
                  type="button"
                  className={activeTab === 'overview' ? 'active' : ''}
                  onClick={() => setActiveTab('overview')}
                >
                  概览
                </button>
                <button
                  type="button"
                  className={activeTab === 'report' ? 'active' : ''}
                  onClick={() => setActiveTab('report')}
                >
                  完整报告
                </button>
              </div>

              <div className="reader-body">
                {activeTab === 'overview' && (
                  <>
                    <section>
                      <div className="section-title">
                        <span>01</span>
                        <h3>论文概览</h3>
                      </div>
                      <p className="lead-copy">{paper.summary}</p>
                    </section>
                    <section>
                      <div className="section-title">
                        <span>02</span>
                        <h3>为什么推荐给你</h3>
                      </div>
                      <div className="reason-card">
                        <Sparkles size={19} />
                        <p>{paper.reason}</p>
                      </div>
                    </section>
                    <section>
                      <div className="section-title">
                        <span>03</span>
                        <h3>阅读时值得留意</h3>
                      </div>
                      <ul>
                        <li>不同截断方法在有限尺寸下如何互相校验。</li>
                        <li>
                          数值方案能否迁移到 anomalous transport 或 quantum
                          dynamics 问题。
                        </li>
                      </ul>
                    </section>
                  </>
                )}
                {activeTab === 'report' && (
                  <section>
                    <div className="section-title">
                      <span>01</span>
                      <h3>完整报告</h3>
                    </div>
                    <p className="lead-copy">
                      报告采用更宽松的行距和受控的阅读宽度，把核心结论、方法、证据与局限分开呈现。这里用于展示长内容的阅读感受。
                    </p>
                    <p>
                      作者将 Hamiltonian truncation
                      的结果与数值对角化进行比较，并给出不同 cutoff
                      下的收敛行为。重要结论使用正文色呈现，来源和编号保留为较弱但仍清晰的辅助信息。
                    </p>
                  </section>
                )}
              </div>
            </article>
          </section>
        </div>
      </section>
      {mobileNav && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="关闭菜单"
          onClick={() => setMobileNav(false)}
        />
      )}
    </main>
  );
}
