// InfoLens Local Reader: Windows tray owner, per-user named pipe and child job object.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Pipes;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

internal static class Program {
    [STAThread] static void Main() {
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        string sid=WindowsIdentity.GetCurrent().User.Value;
        bool created; using(var mutex=new Mutex(true,"Local\\InfoLens.LocalReader."+sid,out created)) {
            if(!created)return;
            try { using(var app=new TrayHost())Application.Run(app); }
            catch(Exception ex){MessageBox.Show(ex.Message,"InfoLens 无法启动",MessageBoxButtons.OK,MessageBoxIcon.Error);}
        }
    }
}
internal sealed class TrayHost : ApplicationContext, IDisposable {
    const string RunKey="Software\\Microsoft\\Windows\\CurrentVersion\\Run", RunName="InfoLensLocalReader";
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    readonly object gate=new object();
    readonly Control dispatcher=new Control();
    readonly NotifyIcon tray=new NotifyIcon();
    FloatingController floating;
    readonly Icon trayImage;
    readonly ToolStripMenuItem statusItem=new ToolStripMenuItem("正在启动…");
    readonly ToolStripMenuItem autoItem=new ToolStripMenuItem("登录 Windows 后启动");
    readonly string node, launcher, url, pipeName, executable=Application.ExecutablePath;
    readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer();
    Process child; IntPtr childJob=IntPtr.Zero; NamedPipeServerStream pipe;
    string bearer, instanceId; volatile bool quitting; int polling; bool disposed;
    public TrayHost() {
        var config=json.Deserialize<Dictionary<string,object>>(File.ReadAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"host-config.json"),Encoding.UTF8));
        node=Path.GetFullPath((string)config["node"]);launcher=Path.GetFullPath((string)config["launcher"]);
        int port=Convert.ToInt32(config["port"]);if(port<1||port>65535)throw new Exception("本机端口无效。");
        if(!File.Exists(node)||!File.Exists(launcher))throw new Exception("运行文件缺失，请重新配置本地路径。");
        url="http://127.0.0.1:"+port;pipeName=GetPipeName();
        dispatcher.CreateControl();var dispatchHandle=dispatcher.Handle;
        var menu=new ContextMenuStrip();statusItem.Enabled=false;menu.Items.Add(statusItem);menu.Items.Add(new ToolStripSeparator());
        Add(menu,"打开阅读工作台",()=>Process.Start(new ProcessStartInfo(url){UseShellExecute=true}));
        Add(menu,"启动后台服务",()=>Execute(new Dictionary<string,object>{{"action","start"}}));
        Add(menu,"预加载模型 / 重试",()=>Execute(new Dictionary<string,object>{{"action","warmup"}}));
        Add(menu,"暂停新分析（保留显示）",()=>Execute(new Dictionary<string,object>{{"action","pause"}}));
        Add(menu,"恢复新分析",()=>Execute(new Dictionary<string,object>{{"action","resume"}}));
        Add(menu,"卸载模型 / 释放显存",()=>Execute(new Dictionary<string,object>{{"action","unload"}}));
        Add(menu,"停止后台服务",()=>Execute(new Dictionary<string,object>{{"action","stop"}}));
        menu.Items.Add(new ToolStripSeparator());autoItem.Checked=Autostart();
        autoItem.Click+=(s,e)=>Background(()=>Execute(new Dictionary<string,object>{{"action","autostart"},{"enabled",!Autostart()}}));menu.Items.Add(autoItem);
        Add(menu,"退出 InfoLens",()=>{Execute(new Dictionary<string,object>{{"action","exit"}});RequestExit();});
        using(var resource=typeof(TrayHost).Assembly.GetManifestResourceStream("InfoLens.Tray.ico")){
            if(resource==null)throw new Exception("托盘图标资源缺失，请重新编译 Host。");
            using(var image=new Icon(resource,SystemInformation.SmallIconSize))trayImage=(Icon)image.Clone();
        }
        tray.Icon=trayImage;tray.Text="InfoLens Local Reader";tray.ContextMenuStrip=menu;tray.Visible=true;
        tray.DoubleClick+=(s,e)=>Process.Start(new ProcessStartInfo(url){UseShellExecute=true});
        floating=new FloatingController(action=>{if(action=="open")Process.Start(new ProcessStartInfo(url){UseShellExecute=true});else Background(()=>Execute(new Dictionary<string,object>{{"action",action}}));},mode=>Background(()=>{var reading=Http("/v1/reading");var defaults=(Dictionary<string,object>)reading["defaults"];defaults["mode"]=mode;Http("/v1/reading/defaults","PUT",new Dictionary<string,object>{{"revision",reading["revision"]},{"settings",defaults}});UpdateStatus();}));
        var floatItem=new ToolStripMenuItem("显示 / 隐藏悬浮控制器");floatItem.Click+=(s,e)=>floating.Toggle();menu.Items.Insert(1,floatItem);
        var fullscreenItem=new ToolStripMenuItem("全屏程序中隐藏悬浮窗"){Checked=floating.HideInFullscreen};fullscreenItem.Click+=(s,e)=>{floating.ToggleFullscreenPolicy();fullscreenItem.Checked=floating.HideInFullscreen;};menu.Items.Insert(2,fullscreenItem);
        timer.Interval=3000;timer.Tick+=(s,e)=>{if(Interlocked.CompareExchange(ref polling,1,0)==0)Task.Run(()=>{try{lock(gate)UpdateStatus();}catch{}finally{Interlocked.Exchange(ref polling,0);}});};timer.Start();
        var thread=new Thread(PipeLoop){IsBackground=true};thread.Start();Background(()=>Execute(new Dictionary<string,object>{{"action","start"}}));
    }
    static string GetPipeName(){using(var sha=SHA256.Create()){var h=sha.ComputeHash(Encoding.UTF8.GetBytes(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile).ToLowerInvariant()));return "InfoLens.LocalReader."+BitConverter.ToString(h).Replace("-","").ToLowerInvariant().Substring(0,16);}}
    void Add(ContextMenuStrip menu,string title,Action action){var item=new ToolStripMenuItem(title);item.Click+=(s,e)=>Background(action);menu.Items.Add(item);}
    void Background(Action action){Task.Run(()=>{try{lock(gate)action();}catch(Exception ex){Ui(()=>{tray.ShowBalloonTip(4000,"InfoLens",ex.Message,ToolTipIcon.Warning);statusItem.Text="操作未完成";});}});}
    void Ui(Action action){if(!quitting&&!dispatcher.IsDisposed)try{dispatcher.BeginInvoke(action);}catch(InvalidOperationException){}}
    Dictionary<string,object> Http(string route,string method="GET",object body=null,bool auth=true){
        var req=(HttpWebRequest)WebRequest.Create(url+route);req.Proxy=null;req.Method=method;req.Timeout=20000;req.ReadWriteTimeout=20000;req.AllowAutoRedirect=false;
        if(auth){if(bearer==null){var session=Http("/v1/session",auth:false);bearer=(string)session["token"];}req.Headers["Authorization"]="Bearer "+bearer;}
        else if(route=="/v1/session")req.Headers["X-InfoLens-Client"]="windows-host";
        if(body!=null){byte[] data=Encoding.UTF8.GetBytes(json.Serialize(body));req.ContentType="application/json";req.ContentLength=data.Length;using(var stream=req.GetRequestStream())stream.Write(data,0,data.Length);}
        using(var response=req.GetResponse())using(var reader=new StreamReader(response.GetResponseStream(),Encoding.UTF8)){return json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());}
    }
    Dictionary<string,object> Health(){var h=Http("/v1/health",auth:false);if(!Convert.ToString(h["source"]).StartsWith("local_")||Convert.ToInt32(h["controlVersion"])!=1)throw new Exception("端口上运行的服务不兼容，请核对端口。");return h;}
    bool Running(){try{var h=Health();string id=(string)h["instanceId"];if(id!=instanceId){instanceId=id;bearer=null;}return true;}catch(WebException){return false;}}
    void StartService(){
        if(Running()){Http("/v1/control","POST",new Dictionary<string,object>{{"action","warmup"}});UpdateStatus();return;}
        if(child!=null&&!child.HasExited)throw new Exception("后台服务仍在启动或端口被占用。");
        ReleaseJob();var info=new ProcessStartInfo(node,"\""+launcher+"\""){WorkingDirectory=Path.GetDirectoryName(launcher),UseShellExecute=false,CreateNoWindow=true,RedirectStandardInput=true,RedirectStandardOutput=true,RedirectStandardError=true};
        info.EnvironmentVariables["INFOLENS_HOST_MANAGED"]="1";child=Process.Start(info);
        try{childJob=JobOwner.Create(child);}catch{child.Kill();throw;}
        child.OutputDataReceived+=(s,e)=>{};child.ErrorDataReceived+=(s,e)=>{};child.BeginOutputReadLine();child.BeginErrorReadLine();
        for(int i=0;i<50;i++){if(child.HasExited)throw new Exception("后台启动失败，请检查模型路径与端口。");if(Running()){UpdateStatus();return;}Thread.Sleep(200);}
        throw new Exception("后台启动超时；可稍后在托盘重试。");
    }
    void StopService(){
        if(child==null||child.HasExited){ReleaseJob();if(Running())throw new Exception("当前服务由其他程序启动。托盘只能停止自己启动的服务。");return;}
        try{child.StandardInput.WriteLine("{\"action\":\"shutdown\"}");child.StandardInput.Flush();}catch{}
        if(!child.WaitForExit(10000)){ReleaseJob();child.WaitForExit(3000);}else ReleaseJob();
        child.Dispose();child=null;bearer=null;instanceId=null;
    }
    void ReleaseJob(){if(childJob!=IntPtr.Zero){JobOwner.CloseHandle(childJob);childJob=IntPtr.Zero;}}
    void RequestExit(){quitting=true;dispatcher.BeginInvoke((Action)(()=>ExitThread()));}
    bool Autostart(){using(var k=Registry.CurrentUser.OpenSubKey(RunKey))return k!=null&&String.Equals(k.GetValue(RunName) as string,"\""+executable+"\"",StringComparison.OrdinalIgnoreCase);}
    void SetAutostart(bool enabled){using(var k=Registry.CurrentUser.CreateSubKey(RunKey)){var existing=k.GetValue(RunName) as string;string expected="\""+executable+"\"";
        if(existing!=null&&!String.Equals(existing,expected,StringComparison.OrdinalIgnoreCase))throw new Exception("启动项已指向其他 InfoLens 安装。请先在旧版本关闭自启。");
        if(enabled)k.SetValue(RunName,expected,RegistryValueKind.String);else if(existing!=null)k.DeleteValue(RunName,false);}}
    Dictionary<string,object> Snapshot(){bool running=Running();var result=new Dictionary<string,object>{{"floating",floating!=null&&floating.EnabledByUser},{"ok",true},{"hostVersion","0.8.19"},{"pipe",pipeName},{"hostPid",Process.GetCurrentProcess().Id},{"serviceRunning",running},{"serviceOwned",child!=null&&!child.HasExited},{"servicePid",child!=null&&!child.HasExited?(object)child.Id:null},{"autostart",Autostart()}};
        result["floatingVisible"]=floating!=null&&floating.NativeVisible;
        if(running)result["service"]=Http("/v1/status");return result;}
    void UpdateStatus(){var r=Snapshot();bool online=(bool)r["serviceRunning"];string label="后台已停止";
        if(online){var s=(Dictionary<string,object>)r["service"];label=Convert.ToString(s["status"])=="loading"?"正在预加载模型…":Convert.ToString(s["status"])=="error"?"模型加载失败 · 可重试":(bool)s["paused"]?"已暂停 · 模型保留":s.ContainsKey("modelsReady")&&s["modelsReady"] is bool&&(bool)s["modelsReady"]?"本地模型已就绪":"模型已卸载 · 可预加载";}
        string readingMode="hybrid";if(online)try{readingMode=Convert.ToString(((Dictionary<string,object>)Http("/v1/reading")["defaults"])["mode"]);}catch{}
        Ui(()=>{if(floating!=null)floating.Reflect(label,online?(Dictionary<string,object>)r["service"]:null,readingMode);statusItem.Text=label;tray.Text="InfoLens · "+label;autoItem.Checked=(bool)r["autostart"];});}
    Dictionary<string,object> Execute(Dictionary<string,object> cmd){lock(gate){
        string action=cmd.ContainsKey("action")?Convert.ToString(cmd["action"]):"";
        if(cmd.Count!=(action=="autostart"?2:1))throw new Exception("控制请求包含未知字段。");
        switch(action){
            case "status":return Snapshot();
            case "floating":Ui(()=>floating.Toggle());break;
            case "start":StartService();break;
            case "pause":case "resume":case "unload":case "warmup":if(!Running())throw new Exception("后台服务未运行。");Http("/v1/control","POST",new Dictionary<string,object>{{"action",action}});break;
            case "stop":StopService();break;
            case "autostart":if(!(cmd["enabled"] is bool))throw new Exception("enabled 必须为布尔值。");SetAutostart((bool)cmd["enabled"]);break;
            case "exit":if(child!=null&&!child.HasExited)StopService();return new Dictionary<string,object>{{"ok",true},{"exiting",true}};
            default:throw new Exception("未知控制操作。");
        }UpdateStatus();return Snapshot();
    }}
    void PipeLoop(){while(!quitting){try{
        var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));
        using(var stream=new NamedPipeServerStream(pipeName,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.None,4096,4096,security)){
            pipe=stream;stream.WaitForConnection();var bytes=new List<byte>();
            // A connected peer must finish its bounded request promptly.
            using(var timeout=new System.Threading.Timer(s=>{try{stream.Dispose();}catch{}},null,5000,Timeout.Infinite)){
                for(int i=0;i<=1024;i++){int b=stream.ReadByte();if(b<0||b==10)break;bytes.Add((byte)b);if(i==1024)throw new Exception("请求过长。");}
                timeout.Change(Timeout.Infinite,Timeout.Infinite);
            }
            var pipeJson=new JavaScriptSerializer();object reply;try{reply=Execute(pipeJson.Deserialize<Dictionary<string,object>>(Encoding.UTF8.GetString(bytes.ToArray())));}catch(Exception ex){reply=new Dictionary<string,object>{{"ok",false},{"error",ex.Message}};}
            byte[] output=Encoding.UTF8.GetBytes(pipeJson.Serialize(reply)+"\n");stream.Write(output,0,output.Length);stream.Flush();
            var exitReply=reply as Dictionary<string,object>;if(exitReply!=null&&exitReply.ContainsKey("exiting"))RequestExit();
        }
    }catch{if(!quitting)Thread.Sleep(100);}finally{pipe=null;}}}
    protected override void ExitThreadCore(){timer.Stop();tray.Visible=false;base.ExitThreadCore();}
    protected override void Dispose(bool disposing){if(disposed)return;disposed=true;quitting=true;if(disposing){timer.Dispose();if(floating!=null)floating.Dispose();tray.Dispose();if(trayImage!=null)trayImage.Dispose();dispatcher.Dispose();if(pipe!=null)pipe.Dispose();ReleaseJob();if(child!=null)child.Dispose();}base.Dispose(disposing);}
}
internal static class JobOwner {
    [StructLayout(LayoutKind.Sequential)] struct Basic {public long Time1,Time2;public uint Flags;public UIntPtr Min,Max;public uint Active;public UIntPtr Affinity;public uint Priority,Scheduling;}
    [StructLayout(LayoutKind.Sequential)] struct Io {public ulong R,W,O,RB,WB,OB;}
    [StructLayout(LayoutKind.Sequential)] struct Extended {public Basic Basic;public Io Io;public UIntPtr ProcessMemory,JobMemory,PeakProcessMemory,PeakJobMemory;}
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attr,string name);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int info,IntPtr data,uint length);
    [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
    [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
    public static IntPtr Create(Process child){var job=CreateJobObject(IntPtr.Zero,null);if(job==IntPtr.Zero)throw new Exception("创建后台进程组失败。");var info=new Extended();info.Basic.Flags=0x2000;int size=Marshal.SizeOf(info);IntPtr buffer=Marshal.AllocHGlobal(size);
        try{Marshal.StructureToPtr(info,buffer,false);if(!SetInformationJobObject(job,9,buffer,(uint)size)||!AssignProcessToJobObject(job,child.Handle))throw new Exception("无法管理后台进程组。");return job;}catch{CloseHandle(job);throw;}finally{Marshal.FreeHGlobal(buffer);}}
}
