import { Component, OnInit, OnDestroy, Input, Output, EventEmitter, ElementRef, ViewChild, AfterViewInit, ChangeDetectorRef, ChangeDetectionStrategy, NgZone } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { createChart, IChartApi, ISeriesApi, LineSeries, ColorType, Time } from 'lightweight-charts';
import { TranslateModule } from '@ngx-translate/core';
import { Buffer } from 'buffer';
import { SerialMonitorService, dataItem } from '../../serial-monitor.service';
import { ElectronService } from '../../../../services/electron.service';

// 预编译正则，避免在热路径中反复创建
const LINE_SPLIT_RE = /\r?\n/;

@Component({
  selector: 'app-serial-chart',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './serial-chart.component.html',
  styleUrl: './serial-chart.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class SerialChartComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild('chartContainer', { static: false }) chartContainerRef!: ElementRef<HTMLDivElement>;

  @Input() visible = false;
  @Output() visibleChange = new EventEmitter<boolean>();

  // 图表相关属性
  private chart: IChartApi | null = null;
  private seriesMap: Map<number, ISeriesApi<'Line'>> = new Map();
  private chartDataMap: Map<number, { time: Time; value: number }[]> = new Map();
  private chartTimeIndex = 0;
  private chartDataSubscription: Subscription | null = null;
  private dataBuffer = ''; // 用于缓存不完整的数据行
  private lastChartTime = 0; // 上一个数据点的时间戳

  // 用于跟踪已处理的数据
  private lastProcessedItemIndex = -1;
  private lastProcessedDataLength = 0;

  // ResizeObserver 引用，用于清理
  private resizeObserver: ResizeObserver | null = null;

  // 定时器批量处理（用 setTimeout 而非 rAF，限制图表更新频率）
  private updateTimerId: ReturnType<typeof setTimeout> | null = null;
  private pendingDataStr = ''; // 累积待处理的数据字符串

  // 图表更新频率：~10fps，将 90% 的帧预算留给 crosshair 交互
  private static readonly CHART_UPDATE_INTERVAL_MS = 100;

  // 数据点超限时的批量裁剪阈值
  private static readonly MAX_DATA_POINTS = 1000;
  private static readonly TRIM_TARGET = 800;

  // 图表颜色配置
  private chartColors = [
    '#2962FF', '#FF6D00', '#2E7D32', '#D50000', '#AA00FF',
    '#00BFA5', '#FFD600', '#C51162', '#6200EA', '#00C853'
  ];

  // 用简单布尔值追踪是否有数据，避免每次变更检测遍历 Map
  hasChartData = false;

  // 自定义 tooltip DOM 引用（纯 DOM 操作，不触发 Angular CD）
  @ViewChild('tooltip', { static: false }) tooltipRef!: ElementRef<HTMLDivElement>;

  constructor(
    private serialMonitorService: SerialMonitorService,
    private electronService: ElectronService,
    private cd: ChangeDetectorRef,
    private ngZone: NgZone
  ) { }

  ngOnInit() { }

  ngAfterViewInit() {
    // 在 Zone 外延迟初始化图表
    this.ngZone.runOutsideAngular(() => {
      setTimeout(() => {
        this.initChart();
      }, 100);
    });
  }

  ngOnDestroy() {
    this.destroyChart();
  }

  /**
   * 初始化 lightweight-charts 图表
   */
  initChart() {
    const chartContainer = this.chartContainerRef?.nativeElement;
    if (!chartContainer) {
      console.warn('图表容器未找到');
      return;
    }

    // 清理旧图表
    this.destroyChart();

    // 在 Angular Zone 外创建图表，确保图表内部所有 DOM 事件监听
    // （mousemove、mouseenter 等）都注册在 root zone，不触发变更检测
    this.ngZone.runOutsideAngular(() => {
      this.chart = createChart(chartContainer, {
        layout: {
          background: { type: ColorType.Solid, color: '#292929' },
          textColor: '#DDD',
        },
        grid: {
          vertLines: { color: '#404040' },
          horzLines: { color: '#404040' },
        },
        width: chartContainer.clientWidth,
        height: chartContainer.clientHeight - 10,
        timeScale: {
          timeVisible: true,
          secondsVisible: true,
          tickMarkFormatter: (time: number) => {
            const date = new Date(time * 1000);
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const seconds = date.getSeconds().toString().padStart(2, '0');
            return `${minutes}:${seconds}`;
          },
        },
        rightPriceScale: {
          borderColor: '#555',
        },
        crosshair: {
          mode: 1, // Magnet — 只在数据点上停留，比 Normal 开销更低
          vertLine: {
            labelVisible: false, // 隐藏时间轴浮动标签，减少 DOM 操作
          },
          horzLine: {
            labelVisible: false, // 隐藏价格轴浮动标签，减少 DOM 操作
          },
        },
        // 禁用自带的刻度标签动画，减轻渲染负担
        handleScroll: true,
        handleScale: true,
        localization: {
          timeFormatter: (time: number) => {
            const date = new Date(time * 1000);
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const seconds = date.getSeconds().toString().padStart(2, '0');
            return `${minutes}:${seconds}`;
          },
        },
      });

      // 监听容器大小变化
      this.resizeObserver = new ResizeObserver(() => {
        if (this.chart && chartContainer) {
          this.chart.applyOptions({
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight - 10,
          });
        }
      });
      this.resizeObserver.observe(chartContainer);

      // 订阅 crosshair 移动事件，用纯 DOM 更新自定义 tooltip（不触发 Angular CD）
      this.chart.subscribeCrosshairMove((param) => {
        const tooltipEl = this.tooltipRef?.nativeElement;
        if (!tooltipEl) return;

        if (!param.time || param.seriesData.size === 0) {
          tooltipEl.style.display = 'none';
          return;
        }

        // 收集所有 series 的值
        let html = '';
        const ts = param.time as number;
        const date = new Date(ts * 1000);
        const hh = date.getHours().toString().padStart(2, '0');
        const mm = date.getMinutes().toString().padStart(2, '0');
        const ss = date.getSeconds().toString().padStart(2, '0');
        const ms = date.getMilliseconds().toString().padStart(3, '0');
        html += `<div class="tooltip-time">${hh}:${mm}:${ss}.${ms}</div>`;

        let hasValues = false;
        this.seriesMap.forEach((series, index) => {
          const d = param.seriesData.get(series) as any;
          if (d && d.value !== undefined) {
            hasValues = true;
            const color = this.chartColors[index % this.chartColors.length];
            const val = Number(d.value).toFixed(2);
            html += `<div class="tooltip-row"><span class="tooltip-color" style="background:${color}"></span><span class="tooltip-title">Ch${index + 1}:</span><span class="tooltip-value">${val}</span></div>`;
          }
        });

        if (!hasValues) {
          tooltipEl.style.display = 'none';
          return;
        }

        tooltipEl.innerHTML = html;

        // 定位 tooltip
        const point = param.point;
        if (point) {
          const containerWidth = chartContainer.clientWidth;
          const tooltipWidth = tooltipEl.offsetWidth || 140;
          let x = point.x + 12;
          if (x + tooltipWidth > containerWidth) {
            x = point.x - tooltipWidth - 12;
          }
          tooltipEl.style.left = Math.max(0, x) + 'px';
          tooltipEl.style.top = '8px';
        }

        tooltipEl.style.display = 'block';
      });
    });

    // 重置数据
    this.seriesMap.clear();
    this.chartDataMap.clear();
    this.chartTimeIndex = 0;
    this.dataBuffer = '';
    this.pendingDataStr = '';
    this.lastProcessedDataLength = 0;
    this.lastProcessedItemIndex = -1;
    this.lastChartTime = 0;

    // 订阅串口数据更新
    // RxJS Subject.next() 在调用者 Zone 中执行回调，
    // 因此必须在回调内部显式 runOutsideAngular
    this.chartDataSubscription = this.serialMonitorService.dataUpdated.subscribe(() => {
      this.ngZone.runOutsideAngular(() => {
        this.processLatestSerialData();
      });
    });
  }

  /**
   * 处理最新的串口数据 — 仅提取新增部分，累积到 pendingDataStr
   */
  private processLatestSerialData() {
    const dataList = this.serialMonitorService.dataList;
    if (dataList.length === 0) return;

    const lastIndex = dataList.length - 1;
    const lastItem = dataList[lastIndex];

    if (lastItem.dir !== 'RX') return;

    const currentData = lastItem.data;
    const currentLength = currentData.length;

    if (lastIndex !== this.lastProcessedItemIndex) {
      this.lastProcessedItemIndex = lastIndex;
      this.lastProcessedDataLength = 0;
    }

    if (currentLength > this.lastProcessedDataLength) {
      const slicedData = currentData.slice(this.lastProcessedDataLength);
      const newDataStr = Buffer.isBuffer(slicedData)
        ? slicedData.toString('utf-8')
        : Buffer.from(slicedData).toString('utf-8');
      this.lastProcessedDataLength = currentLength;

      this.pendingDataStr += newDataStr;
      this.scheduleChartUpdate();
    }
  }

  /**
   * 使用 100ms 定时器调度图表更新（~10fps），
   * 而不是 requestAnimationFrame（60fps）。
   * 
   * 关键优化：rAF 帧帧更新会与 lightweight-charts 的 crosshair 内部 rAF 渲染争抢同一帧，
   * 降低到 10fps 将 90% 的帧预算让渡给 crosshair 交互和 Canvas 重绘。
   * 串口监视器图表不需要 60fps 刷新率。
   */
  private scheduleChartUpdate() {
    if (this.updateTimerId !== null) return;
    this.updateTimerId = setTimeout(() => {
      this.updateTimerId = null;
      const data = this.pendingDataStr;
      this.pendingDataStr = '';
      if (data) {
        this.processChartData(data);
      }
    }, SerialChartComponent.CHART_UPDATE_INTERVAL_MS);
  }

  /**
   * 处理串口数据用于图表显示
   * 数据格式: value,value,value,...\r\n
   */
  private processChartData(dataStr: string) {
    if (!this.chart) {
      return;
    }

    this.dataBuffer += dataStr;

    const lines = this.dataBuffer.split(LINE_SPLIT_RE);
    this.dataBuffer = lines.pop() || '';

    // 收集每个 series 本次需要新增的所有数据点
    const newPointsPerSeries: Map<number, { time: Time; value: number }[]> = new Map();

    for (const line of lines) {
      if (line.trim() === '') continue;

      const parts = line.split(',');
      const values: number[] = [];
      for (let i = 0; i < parts.length; i++) {
        const num = parseFloat(parts[i]);
        if (!isNaN(num)) values.push(num);
      }

      if (values.length === 0) continue;

      const now = Date.now() / 1000;
      const time = (now > this.lastChartTime ? now : this.lastChartTime + 0.001) as Time;
      this.lastChartTime = time as number;

      for (let index = 0; index < values.length; index++) {
        const value = values[index];

        // 确保 series 存在
        if (!this.seriesMap.has(index)) {
          const series = this.chart!.addSeries(LineSeries, {
            color: this.chartColors[index % this.chartColors.length],
            lineWidth: 2,
            title: `Ch${index + 1}`,
            priceLineVisible: false,
            lastValueVisible: true,
            crosshairMarkerVisible: false, // 禁止 crosshair hover 时在线条上画圆点标记
          });
          series.setData([]);
          this.seriesMap.set(index, series);
          this.chartDataMap.set(index, []);
        }

        // 累积到批量更新列表
        if (!newPointsPerSeries.has(index)) {
          newPointsPerSeries.set(index, []);
        }
        newPointsPerSeries.get(index)!.push({ time, value });
      }
    }

    if (newPointsPerSeries.size === 0) return;

    // 批量更新：每个 series 只调用一次 setData()，避免多次 update() 触发多次内部重绘调度
    let needsTrim = false;
    newPointsPerSeries.forEach((points, index) => {
      const seriesData = this.chartDataMap.get(index)!;
      // 将本帧所有新点追加到数据数组
      for (const p of points) {
        seriesData.push(p);
      }
      if (seriesData.length > SerialChartComponent.MAX_DATA_POINTS) {
        needsTrim = true;
      }
    });

    // 裁剪 + 一次性 setData
    if (needsTrim) {
      this.seriesMap.forEach((series, index) => {
        const seriesData = this.chartDataMap.get(index)!;
        if (seriesData.length > SerialChartComponent.MAX_DATA_POINTS) {
          const trimmed = seriesData.slice(seriesData.length - SerialChartComponent.TRIM_TARGET);
          this.chartDataMap.set(index, trimmed);
          series.setData(trimmed);
        } else if (newPointsPerSeries.has(index)) {
          // 不需要裁剪但有新数据 → setData 一次
          series.setData(seriesData);
        }
      });
    } else {
      // 无需裁剪的情况：只对有新数据的 series 调用一次 setData
      newPointsPerSeries.forEach((_, index) => {
        const series = this.seriesMap.get(index)!;
        const seriesData = this.chartDataMap.get(index)!;
        series.setData(seriesData);
      });
    }

    // 滚动到最新
    if (this.chart) {
      this.chart.timeScale().scrollToRealTime();
    }

    // 仅首次收到数据时通知 Angular 更新视图（隐藏空状态提示）
    if (!this.hasChartData) {
      this.hasChartData = true;
      this.ngZone.run(() => {
        this.cd.markForCheck();
      });
    }
  }

  /**
   * 销毁图表
   */
  destroyChart() {
    if (this.updateTimerId !== null) {
      clearTimeout(this.updateTimerId);
      this.updateTimerId = null;
    }
    if (this.chartDataSubscription) {
      this.chartDataSubscription.unsubscribe();
      this.chartDataSubscription = null;
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
    this.seriesMap.clear();
    this.chartDataMap.clear();
    this.dataBuffer = '';
    this.pendingDataStr = '';
    this.lastProcessedItemIndex = -1;
    this.lastProcessedDataLength = 0;
    this.lastChartTime = 0;
  }

  /**
   * 清空图表数据
   */
  clearChartData() {
    this.chartTimeIndex = 0;
    this.dataBuffer = '';
    this.pendingDataStr = '';
    this.lastProcessedItemIndex = -1;
    this.lastProcessedDataLength = 0;
    this.lastChartTime = 0;
    this.hasChartData = false;
    this.ngZone.runOutsideAngular(() => {
      this.seriesMap.forEach((series, index) => {
        this.chartDataMap.set(index, []);
        series.setData([]);
      });
    });
    this.cd.markForCheck();
  }

  openUrl(url: string) {
    this.electronService.openUrl(url);
  }
}
