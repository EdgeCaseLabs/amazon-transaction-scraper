import * as fs from 'fs-extra';
import * as path from 'path';
import { ConfigData } from './types';

class Config {
  private configPath: string;
  private data!: ConfigData;

  constructor() {
    this.configPath = path.join(__dirname, '..', 'config.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, 'utf8');
        this.data = JSON.parse(data) as ConfigData;
      } else {
        throw new Error(`Config file not found: ${this.configPath}. Please ensure config.json exists in the project root.`);
      }
    } catch (error) {
      console.error('Error loading config:', error);
      throw error;
    }
  }

  public save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
    } catch (error) {
      console.error('Error saving config:', error);
    }
  }

  public get(key: string): any {
    return key.split('.').reduce((obj: any, k: string) => obj && obj[k], this.data);
  }

  public set(key: string, value: any): void {
    const keys = key.split('.');
    const lastKey = keys.pop();
    if (!lastKey) return;
    
    const target = keys.reduce((obj: any, k: string) => obj[k] = obj[k] || {}, this.data);
    target[lastKey] = value;
    this.save();
  }
}

export default new Config();