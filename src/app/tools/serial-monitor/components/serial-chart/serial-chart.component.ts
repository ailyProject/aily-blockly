import { Component, OnInit, OnDestroy, Input, Output, EventEmitter, ElementRef, ViewChild, AfterViewInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Subscription } from 'rxjs';
import { createChart, IChartApi, ISeriesApi, LineSeries, ColorType, Time } from 'lightweight-charts';
import { TranslateModule } from '@ngx-translate/core';
import { Buffer } from 'buffer';
import { SerialMonitorService, dataItem } from '../../serial-monitor.service';
import { ElectronService } from '../../../../services/electron.service';

@Component({
  selector: 'app-serial-chart',
  standalone: true,
  imports: [CommonModule, TranslateModule],
  templateUrl: './serial-chart.component.html',
  styleUrl: './serial-chart.component.scss'
})
export class SerialChartComponent implements OnInit, AfterViewInit, OnDestroy {
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

  // 图表颜色配置
  private chartColors = [
    '#2962FF', '#FF6D00', '#2E7D32', '#D50000', '#AA00FF',
    '#00BFA5', '#FFD600', '#C51162', '#6200EA', '#00C853'
  ];

  // 判断图表是否有数据
  get hasChartData(): boolean {
    if (this.chartDataMap.size === 0) return false;
    for (const data of this.chartDataMap.values()) {
      if (data.length > 0) return true;
    }
    return false;
  }

  constructor(
    private serialMonitorService: SerialMonitorService,
    private electronService: ElectronService,
    private cd: ChangeDetectorRef
  ) { }

  ngOnInit() { }

  ngAfterViewInit() {
    if (this.visible) {
      // 延迟初始化图表，确保 DOM 元素已渲染
      setTimeout(() => {
        this.initChart();
      }, 100);
    }
  }

  ngOnDestroy() {
    this.destroyChart();
  }

  /**
   * 初始化 lightweight-charts 图表
   */
  initChart() {
    const chartContainer = document.getElementById('LightweightChart');
    if (!chartContainer) {
      console.warn('图表容器未找到');
      return;
    }

    // 清理旧图表
    this.destroyChart();

    // 创建新图表
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
        mode: 1, // Normal mode
      },
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
    const resizeObserver = new ResizeObserver(entries => {
      if (this.chart && chartContainer) {
        this.chart.applyOptions({
          width: chartContainer.clientWidth,
          height: chartContainer.clientHeight - 10,
        });
      }
    });
    resizeObserver.observe(chartContainer);

    // 重置数据
    this.seriesMap.clear();
    this.chartDataMap.clear();
    this.chartTimeIndex = 0;
    this.dataBuffer = '';
    this.lastProcessedDataLength = 0;
    this.lastProcessedItemIndex = -1;
    this.lastChartTime = 0;

    // 订阅串口数据更新
    this.chartDataSubscription = this.serialMonitorService.dataUpdated.subscribe(() => {
      this.processLatestSerialData();
    });
  }

  /**
   * 处理最新的串口数据
   */
  private processLatestSerialData() {
    const dataList = this.serialMonitorService.dataList;
    if (dataList.length === 0) return;

    // 获取最后一个数据项
    const lastIndex = dataList.length - 1;
    const lastItem = dataList[lastIndex];

    // 只处理 RX 类型的数据
    if (lastItem.dir !== 'RX') return;

    const currentData = lastItem.data;
    const currentLength = currentData.length;

    // 如果是新的数据项
    if (lastIndex !== this.lastProcessedItemIndex) {
      this.lastProcessedItemIndex = lastIndex;
      this.lastProcessedDataLength = 0;
    }

    // 只处理新增的数据部分
    if (currentLength > this.lastProcessedDataLength) {
      // 使用 Buffer.from 确保正确处理切片数据
      const slicedData = currentData.slice(this.lastProcessedDataLength);
      // 直接转换为字符串，确保使用正确的编码
      const newDataStr = Buffer.isBuffer(slicedData)
        ? slicedData.toString('utf-8')
        : Buffer.from(slicedData).toString('utf-8');
      this.lastProcessedDataLength = currentLength;
      this.processChartData(newDataStr);
    }
  }

  /**
   * 处理串口数据用于图表显示
   * 数据格式: value,value,value,...\r\n
   */
  private processChartData(dataStr: string) {
    if (!this.chart) {
      console.warn('图表未初始化');
      return;
    }

    console.log('收到图表数据:', JSON.stringify(dataStr));

    // 将新数据添加到缓冲区
    this.dataBuffer += dataStr;

    // 按换行符分割数据
    const lines = this.dataBuffer.split(/\r?\n/);

    // 最后一个元素可能是不完整的行，保留在缓冲区
    this.dataBuffer = lines.pop() || '';

    // 处理完整的行
    for (const line of lines) {
      if (line.trim() === '') continue;

      console.log('处理行:', JSON.stringify(line));

      // 尝试解析逗号分隔的数值
      const values = line.split(',').map(v => {
        const num = parseFloat(v.trim());
        return isNaN(num) ? null : num;
      }).filter(v => v !== null) as number[];

      if (values.length === 0) continue;

      console.log('解析到数值个数:', values.length, '值:', values);

      // 使用当前时间戳（秒，保留小数以支持毫秒精度）作为时间轴
      // 确保时间戳严格递增
      const now = Date.now() / 1000;
      const time = (now > this.lastChartTime ? now : this.lastChartTime + 0.001) as Time;
      this.lastChartTime = time as number;

      // 为每个值更新对应的折线
      values.forEach((value, index) => {
        // 如果这个索引的折线不存在，创建新的
        if (!this.seriesMap.has(index)) {
          const series = this.chart!.addSeries(LineSeries, {
            color: this.chartColors[index % this.chartColors.length],
            lineWidth: 2,
            title: `Ch${index + 1}`,
            priceLineVisible: false,
            lastValueVisible: true,
          });
          // 必须先设置初始空数据，之后 update 才能工作
          series.setData([]);
          this.seriesMap.set(index, series);
          this.chartDataMap.set(index, []);
        }

        // 获取该折线的数据数组和 series
        const seriesData = this.chartDataMap.get(index)!;
        const series = this.seriesMap.get(index)!;

        // 使用 update 实时更新数据点
        const dataPoint = { time, value };
        seriesData.push(dataPoint);

        // 限制数据点数量，保持最近1000个点
        if (seriesData.length > 1000) {
          seriesData.shift();
          // 当数据太多时，重新设置整个数据集
          series.setData(seriesData);
        } else {
          // 使用 update 实时添加新数据点
          series.update(dataPoint);
        }
      });

      // 自动滚动到最新数据
      if (this.chart) {
        this.chart.timeScale().scrollToRealTime();
      }
    }
    
    this.cd.detectChanges();
  }

  /**
   * 销毁图表
   */
  destroyChart() {
    if (this.chartDataSubscription) {
      this.chartDataSubscription.unsubscribe();
      this.chartDataSubscription = null;
    }
    if (this.chart) {
      this.chart.remove();
      this.chart = null;
    }
    this.seriesMap.clear();
    this.chartDataMap.clear();
    this.dataBuffer = '';
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
    this.lastProcessedItemIndex = -1;
    this.lastProcessedDataLength = 0;
    this.lastChartTime = 0;
    this.seriesMap.forEach((series, index) => {
      this.chartDataMap.set(index, []);
      series.setData([]);
    });
  }

  openUrl(url: string) {
    this.electronService.openUrl(url);
  }
}
